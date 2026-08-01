import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { GitHubClient } from '../Actions/Mirror/github-client'
import type { MappedIssue, MappedPull } from '../Actions/Mirror/github'
import { buildThreads, mapIssue, mapPull, mapReviewComment, onlyIssues } from '../Actions/Mirror/github'
import {
  issueRow,
  metadataBackoffSeconds,
  pullNumberOf,
  pullRow,
  planByExternalId,
  planByNumber,
  reviewCommentRow,
  threadRow,
} from '../Actions/Mirror/metadata'

/**
 * Import a mirrored repository's issues, pull requests and review threads.
 *
 * Separate from `MirrorSyncJob` because the two cost differently and fail
 * differently. Commits come from one `git fetch`; metadata is many API calls
 * against a rate limit shared by every mirror using the same token. Folding
 * them together would mean a rate limit on the backlog stopped the commits from
 * updating, and would make the repository page say the mirror is broken when
 * only half of it is.
 *
 * The import is one-way. A mirror is a view of somewhere else, and writing
 * local review state back upstream is a different feature with a different set
 * of ways to go wrong.
 */
export default new Job({
  name: 'MirrorMetadataSync',
  description: 'Import issues, pull requests and review threads from the upstream host',
  queue: 'mirrors',
  tries: 2,
  backoff: 120,

  async handle(payload: { mirrorId: number }) {
    const mirrorId = Number(payload?.mirrorId)
    if (!Number.isFinite(mirrorId))
      return { ok: false, reason: 'no mirror id' }

    const mirror: any = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('id', '=', mirrorId)
      .executeTakeFirst()

    if (!mirror)
      return { ok: false, reason: 'mirror not found' }

    if (!mirror.enabled || !mirror.sync_metadata)
      return { ok: false, reason: 'metadata sync not enabled' }

    if (String(mirror.provider ?? '') !== 'github')
      return { ok: false, reason: `no metadata importer for ${mirror.provider}` }

    const owner = String(mirror.remote_owner ?? '')
    const name = String(mirror.remote_name ?? '')
    if (!owner || !name)
      return { ok: false, reason: 'mirror does not name a remote repository' }

    const repositoryId = Number(mirror.repository_id)
    const client = new GitHubClient({ token: resolveToken(mirror.credential_ref) })

    // Who upstream maps to a local user. Read once: the alternative is a query
    // per row, and an import of two thousand issues would spend longer in the
    // database than on the network.
    const linked = await linkedAccounts()

    const issuesResult = await client.issues(owner, name)
    const pullsResult = await client.pulls(owner, name)
    const commentsResult = await client.reviewComments(owner, name)

    // A partial import is still worth writing. Whatever came back is real, and
    // discarding it because a later page failed means starting from nothing
    // next time and hitting the same limit at the same place.
    const failure = [issuesResult, pullsResult, commentsResult].find(r => !r.ok)

    const issues = onlyIssues(issuesResult.items)
      .map(item => mapIssue(item, linked))
      .filter((item): item is NonNullable<typeof item> => item !== null)

    const pulls = pullsResult.items
      .map(item => mapPull(item, linked))
      .filter((item): item is NonNullable<typeof item> => item !== null)

    const written = {
      issues: await writeIssues(issues, repositoryId),
      pulls: await writePulls(pulls, repositoryId),
      threads: await writeReviewThreads(commentsResult.items, repositoryId, linked),
    }

    if (failure) {
      const failures = Number(mirror.metadata_failure_count ?? 0) + 1

      await db
        .updateTable('repository_mirrors')
        .set({
          metadata_error: failure.error,
          metadata_failure_count: failures,
          // The successful part still counts as progress, so the timestamp
          // moves. Without it a mirror that always fails on its last page would
          // re-import everything before it on every single sweep.
          last_metadata_sync_at: new Date().toISOString(),
        })
        .where('id', '=', mirrorId)
        .execute()

      dispatch('mirror:metadata-failed', { mirrorId, repositoryId, error: failure.error, written })

      return {
        ok: false,
        reason: failure.error,
        written,
        retryInSeconds: metadataBackoffSeconds(failures),
      }
    }

    await db
      .updateTable('repository_mirrors')
      .set({ last_metadata_sync_at: new Date().toISOString(), metadata_error: null, metadata_failure_count: 0 })
      .where('id', '=', mirrorId)
      .execute()

    dispatch('mirror:metadata-synced', { mirrorId, repositoryId, written })

    return { ok: true, written }
  },
})

/**
 * GitHub logins mapped to local user ids, lowercased.
 *
 * Only accounts a user has actually linked appear here. An unlinked login is
 * shown by name and attributed to nobody: two people with the same handle on
 * two hosts is ordinary, and putting words in someone's mouth is not a bug you
 * can apologise your way out of.
 */
async function linkedAccounts(): Promise<Map<string, number>> {
  const rows: any[] = await db
    .selectFrom('users')
    .select(['id', 'github_username'])
    // `whereNotNull` rather than `where(col, 'is not', null)`: the latter binds
    // the null as a parameter and Postgres rejects `IS NOT $1`.
    .whereNotNull('github_username')
    .execute()

  const map = new Map<string, number>()
  for (const row of rows) {
    const login = String(row.github_username ?? '').trim().toLowerCase()
    if (login) map.set(login, Number(row.id))
  }
  return map
}

/**
 * The token for a mirror, by reference.
 *
 * The mirror row stores a name, never a secret: a token copied into the
 * database is a token in every backup and every dump anyone takes of it.
 */
function resolveToken(credentialRef: string | null | undefined): string | null {
  const ref = String(credentialRef ?? '').trim()
  if (!ref) return process.env.GITHUB_TOKEN ?? null

  return process.env[`MIRROR_TOKEN_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? null
}

async function writeIssues(present: MappedIssue[], repositoryId: number) {
  if (present.length === 0) return { created: 0, updated: 0 }

  const rows: any[] = await db
    .selectFrom('issues')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .where('is_pull_request', '=', false)
    .execute()

  const existing = new Map(rows.map(r => [Number(r.number), { id: Number(r.id) }]))
  const plan = planByNumber(present, existing)

  for (const item of plan.create)
    await db.insertInto('issues').values(issueRow(item, repositoryId) as any).execute()

  for (const { id, incoming } of plan.update)
    await db.updateTable('issues').set(issueRow(incoming, repositoryId) as any).where('id', '=', id).execute()

  return { created: plan.create.length, updated: plan.update.length }
}

async function writePulls(present: MappedPull[], repositoryId: number) {
  if (present.length === 0) return { created: 0, updated: 0 }

  const rows: any[] = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const existing = new Map(rows.map(r => [Number(r.number), { id: Number(r.id) }]))
  const plan = planByNumber(present, existing)

  for (const item of plan.create)
    await db.insertInto('pull_requests').values(pullRow(item, repositoryId) as any).execute()

  for (const { id, incoming } of plan.update)
    await db.updateTable('pull_requests').set(pullRow(incoming, repositoryId) as any).where('id', '=', id).execute()

  return { created: plan.create.length, updated: plan.update.length }
}

/**
 * Import review comments as threads hanging off their pull requests.
 *
 * Threads are rebuilt rather than read: GitHub models one as a root comment
 * plus replies pointing at it, and the shape only exists once those pointers
 * are followed.
 */
async function writeReviewThreads(
  rawComments: any[],
  repositoryId: number,
  linked: Map<string, number>,
) {
  if (rawComments.length === 0) return { created: 0, updated: 0 }

  const pullRows: any[] = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const pullIdByNumber = new Map(pullRows.map(r => [Number(r.number), Number(r.id)]))

  // Group by pull request first, because a thread never spans two of them and
  // building threads across the whole repository at once would let a reply id
  // collide with a root id from a different conversation.
  const byPull = new Map<number, any[]>()
  for (const raw of rawComments) {
    const number = pullNumberOf(raw)
    if (number === null) continue

    const pullId = pullIdByNumber.get(number)
    // A comment on a pull request that was not imported has nowhere to hang.
    // It is skipped rather than dropped silently: the next sync, once the pull
    // request is in, picks it up.
    if (pullId === undefined) continue

    const list = byPull.get(pullId) ?? []
    list.push(raw)
    byPull.set(pullId, list)
  }

  let created = 0
  let updated = 0

  for (const [pullId, raws] of byPull) {
    const mapped = raws
      .map(raw => mapReviewComment(raw, linked))
      .filter((c): c is NonNullable<typeof c> => c !== null)

    for (const thread of buildThreads(mapped)) {
      const row = threadRow(thread, pullId)
      if (!row) continue

      const existingThread: any = await db
        .selectFrom('review_threads')
        .select(['id'])
        .where('external_id', '=', row.external_id as number)
        .executeTakeFirst()

      let threadId: number
      if (existingThread) {
        threadId = Number(existingThread.id)
        await db.updateTable('review_threads').set(row as any).where('id', '=', threadId).execute()
      }
      else {
        const inserted: any = await db
          .insertInto('review_threads')
          .values(row as any)
          .returning(['id'])
          .executeTakeFirst()
        threadId = Number(inserted?.id)
      }

      if (!Number.isFinite(threadId)) continue

      const commentRows: any[] = await db
        .selectFrom('review_comments')
        .select(['id', 'external_id'])
        .where('review_thread_id', '=', threadId)
        .execute()

      const existing = new Map(
        commentRows
          .filter(r => r.external_id !== null)
          .map(r => [Number(r.external_id), { id: Number(r.id) }]),
      )

      const plan = planByExternalId(thread, existing)

      for (const comment of plan.create) {
        await db.insertInto('review_comments').values(reviewCommentRow(comment, threadId) as any).execute()
        created++
      }

      for (const { id, incoming } of plan.update) {
        await db
          .updateTable('review_comments')
          .set(reviewCommentRow(incoming, threadId) as any)
          .where('id', '=', id)
          .execute()
        updated++
      }
    }
  }

  return { created, updated }
}
