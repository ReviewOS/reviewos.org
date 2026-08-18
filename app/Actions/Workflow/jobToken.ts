import { db } from '@stacksjs/database'
import { generateToken } from '../Tokens/secret'
import { resolvePermissions } from './permissions'
import type { RepositoryScope, TokenLevel } from '../../TokenScopes'

/**
 * The token a job gets for talking to this instance's API.
 *
 * `permissions:` has been parsed, stored and shown on the run screen since the
 * beginning, and nothing has ever *acted* on it - which is the same recurring
 * defect as `fail-fast` and `timeout-minutes` before it: a key a reviewer reads
 * as a control, that controls nothing.
 *
 * Three properties, and each one is a decision:
 *
 * **Scoped to one repository.** Selected, never `all`. A job that can post a
 * comment on the repository it is building must not be able to post one on
 * every repository its actor can reach - and a token that could is the reason
 * people are afraid of CI having any credentials at all.
 *
 * **It expires with the job**, and is revoked when the job reports. The lease
 * is a backstop rather than the mechanism: a runner that dies holding a token
 * leaves one that stops working on its own within the hour.
 *
 * **A fork's pull request gets read access whatever the file says.** The
 * workflow in a fork's branch is the fork's code, and it does not get to
 * declare what it may do to this repository. Written here rather than left to
 * the claim, because it is the rule most likely to be lost in a refactor.
 */

/** How long a job's token lives when nothing revokes it first. */
export const JOB_TOKEN_MINUTES = 60

export interface MintedToken {
  token: string
  /** The row, so the report can revoke it. */
  id: number
  granted: Partial<Record<RepositoryScope, TokenLevel>>
  /** Keys the workflow asked for that this instance has no scope for. */
  unsupported: string[]
}

/**
 * What this job's token may do.
 *
 * Pure and separate, because it is the part where being wrong hands a fork's
 * pull request write access to the repository it forked.
 */
export function grantsFor(input: {
  workflowPermissions: unknown
  jobPermissions: unknown
  trusted: boolean
}): { granted: Partial<Record<RepositoryScope, TokenLevel>>, unsupported: string[], reduced: boolean } {
  const resolved = resolvePermissions(input.workflowPermissions, input.jobPermissions)

  if (input.trusted)
    return { granted: resolved.granted, unsupported: resolved.unsupported, reduced: false }

  /*
   * An untrusted run is a fork's code, and its own workflow file asked for
   * these permissions. Read access to the contents is what it gets - enough to
   * check out and build, which is what a fork's pull request is for.
   */
  const wanted = Object.keys(resolved.granted).length

  return {
    granted: { contents: 'read' },
    unsupported: resolved.unsupported,
    reduced: wanted > 1 || resolved.granted.contents === 'write',
  }
}

/**
 * Mint one, for one job.
 *
 * Belongs to the run's actor, scoped to the one repository, carrying only the
 * levels resolved above. Acting as the actor rather than as a machine account
 * is the pragmatic choice here - a token has to belong to somebody, and the
 * person whose push started the run is the honest answer - and the scoping is
 * what makes it safe: it reaches this repository and nothing else they can see.
 */
export async function mintJobToken(input: {
  runId: number
  jobId: number
  repositoryId: number
  actorId: number | null
  trusted: boolean
  workflowPermissions: unknown
  jobPermissions: unknown
  now?: Date
}): Promise<MintedToken | null> {
  if (!input.actorId)
    return null

  const now = input.now ?? new Date()
  const grants = grantsFor({
    workflowPermissions: input.workflowPermissions,
    jobPermissions: input.jobPermissions,
    trusted: input.trusted,
  })

  const secret = generateToken()

  const row = await db
    .insertInto('access_tokens')
    .values({
      user_id: input.actorId,
      // Named after the job, so a person looking at their token list sees what
      // it is rather than a row they do not remember creating.
      name: `Run ${input.runId}, job ${input.jobId}`,
      prefix: secret.prefix,
      token_hash: secret.hash,
      // Never `all`. A job that can comment on the repository it builds must
      // not be able to comment on every repository its actor can reach.
      selection: 'selected',
      expires_at: new Date(now.getTime() + JOB_TOKEN_MINUTES * 60_000).toISOString(),
    } as any)
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => null)

  if (!row?.id)
    return null

  await db
    .insertInto('access_token_repositories')
    .values({ access_token_id: Number(row.id), repository_id: input.repositoryId } as any)
    .execute()
    .catch(() => null)

  for (const [scope, level] of Object.entries(grants.granted)) {
    await db
      .insertInto('access_token_permissions')
      .values({ access_token_id: Number(row.id), scope, level } as any)
      .execute()
      .catch(() => null)
  }

  return {
    token: secret.token,
    id: Number(row.id),
    granted: grants.granted,
    unsupported: grants.unsupported,
  }
}

/**
 * Revoke it, when the job is over.
 *
 * By name rather than by a column on the job, because the job row is the one
 * thing a runner can make this instance write - and a revocation that depended
 * on the runner reporting cleanly would leave a live credential every time one
 * died. The expiry is the backstop; this is the ordinary path.
 */
export async function revokeJobTokens(runId: number, jobId: number, now: Date = new Date()): Promise<void> {
  await db
    .updateTable('access_tokens')
    .set({ revoked_at: now.toISOString() } as any)
    .where('name', '=', `Run ${runId}, job ${jobId}`)
    // `whereNull`, not `where(col, 'is', null)`: this builder binds the null as
    // a parameter, so the spelling everybody reaches for first matches nothing
    // and the revocation silently does nothing.
    .whereNull('revoked_at')
    .execute()
    .catch(() => null)
}
