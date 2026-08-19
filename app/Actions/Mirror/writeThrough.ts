/**
 * Posting a review back to the forge it was mirrored from, as the person who
 * wrote it.
 *
 * ## Why this is per-user and has no fallback
 *
 * The phase 13 rule: *never write back with a shared or admin credential*. It
 * reads like a security preference and it is really a product one. A review is
 * somebody's judgement about somebody else's code, and the name on it is most
 * of what it is worth. A bot account posting "on behalf of chris" turns a
 * verdict into a quotation, drops the reviewer out of GitHub's own
 * notifications, review-request accounting and branch-protection counts, and
 * leaves the author replying to a machine.
 *
 * So `credentialFor` looks up one person's own token and returns null when
 * there is not one. There is deliberately no `?? mirrorToken(...)`: the mirror
 * credential exists to fetch, it is usually a machine account, and the moment
 * it is allowed to write, every review posted through it is attributed to it.
 * A missing credential means the review stays here, and the caller says so.
 *
 * ## Why the result syncs back rather than being trusted
 *
 * Upstream is the source of truth for a mirror. The response's review id is
 * recorded so the next metadata sync recognises the review as one already
 * imported rather than filing a second copy of it, but the row it will hold is
 * whatever GitHub says a moment later - including the state GitHub decided,
 * which is not always the state that was asked for (a review on a stale head,
 * or an approval on your own pull request).
 */

import { db } from '@stacksjs/database'
import { isTrue } from '../Support/sql'
import { decrypt } from '@stacksjs/security'
import { GitHubClient } from './github-client'

/** A credential, resolved and opened, for one write. */
export interface ForgeCredential {
  id: number
  token: string
  login: string | null
  scopes: string[]
}

/** The scope GitHub requires to post a review on somebody's behalf. */
export const REVIEW_SCOPES: readonly string[] = ['repo', 'public_repo']

export type WriteThroughRefusal =
  | { ok: false, reason: 'no-credential' }
  | { ok: false, reason: 'missing-scope', has: string[] }

export type WriteThroughOutcome =
  | { ok: true, externalId: number, state: string, url: string | null }
  | WriteThroughRefusal
  | { ok: false, reason: 'upstream-refused', status: number, message: string }

/**
 * This person's credential for this host, or null.
 *
 * Null is a complete answer and the only other one: there is no instance
 * credential to fall back to, by design.
 */
export async function credentialFor(userId: number, host: string, provider = 'github'): Promise<ForgeCredential | null> {
  const row = await db
    .selectFrom('forge_credentials')
    .select(['id', 'sealed', 'remote_login', 'scopes'])
    .where('user_id', '=', userId)
    .where('provider', '=', provider)
    .where('host', '=', host)
    .executeTakeFirst()

  if (!row)
    return null

  try {
    return {
      id: Number(row.id),
      token: String(await decrypt(String(row.sealed))),
      login: row.remote_login ? String(row.remote_login) : null,
      scopes: String(row.scopes ?? '').split(/[\s,]+/).filter(Boolean),
    }
  }
  catch {
    // A credential that cannot be opened is a credential that is gone: the
    // instance key was rotated, or the row was restored from a backup taken
    // under a different one. Treated as absent rather than as an error, so the
    // review still lands here and the person is told to reconnect.
    return null
  }
}

/** Whether a credential says it may write a review, before one is attempted. */
export function mayWriteReviews(credential: ForgeCredential): boolean {
  // An empty scope list is what a fine-grained token reports, and those carry
  // their permissions out of band - so it is allowed through to the API, which
  // is the only thing that can actually answer. A *listed* set that names
  // neither scope is a classic token that certainly cannot.
  return credential.scopes.length === 0 || credential.scopes.some(scope => REVIEW_SCOPES.includes(scope))
}

/** GitHub's word for the state, which is not quite ours. */
export function upstreamReviewEvent(state: string): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (state === 'approved')
    return 'APPROVE'

  if (state === 'changes_requested')
    return 'REQUEST_CHANGES'

  return 'COMMENT'
}

/** The mirror a repository is a copy of, when it is one and writes are allowed. */
export async function writeThroughTarget(repositoryId: number): Promise<{
  owner: string
  name: string
  host: string
  provider: string
} | null> {
  const mirror = await db
    .selectFrom('repository_mirrors')
    .select(['remote_owner', 'remote_name', 'remote_url', 'provider', 'direction', 'enabled', 'write_through'])
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst()

  if (!mirror || !isTrue(mirror.enabled) || !isTrue(mirror.write_through))
    return null

  const owner = String(mirror.remote_owner ?? '').trim()
  const name = String(mirror.remote_name ?? '').trim()

  if (!owner || !name)
    return null

  return { owner, name, host: hostOf(String(mirror.remote_url ?? '')), provider: String(mirror.provider ?? 'github') }
}

/** The host a remote URL names, which is which credential to look for. */
export function hostOf(remoteUrl: string): string {
  const url = String(remoteUrl ?? '').trim()

  if (!url)
    return 'github.com'

  // `git@github.com:owner/name.git` is not a URL any parser takes, and it is
  // the form half of the mirrors carry.
  const scp = /^[^@/]+@([^:]+):/.exec(url)

  if (scp)
    return scp[1]!.toLowerCase()

  try {
    return new URL(url).host.toLowerCase()
  }
  catch {
    return 'github.com'
  }
}

/**
 * Post one review upstream, as the person who wrote it.
 *
 * Every refusal is a value rather than an exception, and each names what the
 * person can do about it: connect an account, reconnect one with the right
 * scope, or read what upstream said.
 */
export async function postReviewUpstream(input: {
  repositoryId: number
  userId: number
  pullNumber: number
  state: string
  body: string
  commitSha?: string | null
  comments?: Array<{ path: string, line: number, side?: string, body: string }>
  fetchImpl?: typeof fetch
  baseUrl?: string
}): Promise<WriteThroughOutcome | { ok: false, reason: 'not-a-mirror' }> {
  const target = await writeThroughTarget(input.repositoryId)

  if (!target)
    return { ok: false, reason: 'not-a-mirror' }

  const credential = await credentialFor(input.userId, target.host, target.provider)

  // The rule, in the one place it can be broken: no fallback. A mirror token is
  // in scope here and is deliberately not consulted.
  if (!credential)
    return { ok: false, reason: 'no-credential' }

  if (!mayWriteReviews(credential))
    return { ok: false, reason: 'missing-scope', has: credential.scopes }

  const client = new GitHubClient({
    token: credential.token,
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
  })

  const answer = await client.postReview({
    owner: target.owner,
    name: target.name,
    number: input.pullNumber,
    event: upstreamReviewEvent(input.state),
    body: input.body,
    commitId: input.commitSha ?? null,
    comments: input.comments,
  })

  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

  if (!answer.ok) {
    await db
      .updateTable('forge_credentials')
      .set({ last_error: answer.message.slice(0, 500) })
      .where('id', '=', credential.id)
      .execute()
      .catch(() => undefined)

    return { ok: false, reason: 'upstream-refused', status: answer.status, message: answer.message }
  }

  await db
    .updateTable('forge_credentials')
    .set({ last_used_at: now, last_error: null })
    .where('id', '=', credential.id)
    .execute()
    .catch(() => undefined)

  return {
    ok: true,
    externalId: Number(answer.review?.id ?? 0),
    state: String(answer.review?.state ?? '').toLowerCase(),
    url: answer.review?.html_url ? String(answer.review.html_url) : null,
  }
}
