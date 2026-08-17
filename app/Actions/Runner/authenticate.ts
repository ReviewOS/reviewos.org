/**
 * Which runner is speaking.
 *
 * Its own credential, not a user's and not a repository's. A runner is a
 * machine an operator registered, and the token it holds says only "I am that
 * machine" - what it may then see is decided by its scope, in
 * [the protocol rules](./protocol.ts).
 *
 * The token is compared by hash, because that is the only form stored: a
 * registration token in the database in plain text is one in every backup.
 */

import { db } from '@stacksjs/database'
import type { RunnerFacts } from './protocol'
import { splitLabels } from './protocol'

/** SHA-256, the same way registration wrote it. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

/**
 * The bearer token on a request, or an empty string.
 *
 * Only the `Bearer` form. A token in a query string is a token in the access
 * log, in the referrer, and in somebody's shell history, and accepting it "for
 * convenience" is how it ends up there.
 */
export function bearerFrom(request: any): string {
  const header = String(request?.headers?.get?.('authorization') ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())

  return match ? String(match[1]).trim() : ''
}

export interface AuthenticatedRunner {
  facts: RunnerFacts
  /** The row, for callers that need more than the decision needs. */
  row: any
}

/**
 * Resolve the runner behind a request, or null.
 *
 * Null covers every failure - no header, unknown token, disabled runner -
 * deliberately, and the caller answers all of them the same way. Telling an
 * unauthenticated caller *which* of those it was is telling it whether a token
 * exists.
 */
export async function authenticateRunner(request: any): Promise<AuthenticatedRunner | null> {
  const token = bearerFrom(request)
  if (!token)
    return null

  const row: any = await db
    .selectFrom('runners')
    .select(['id', 'name', 'state', 'scope_type', 'scope_id', 'labels', 'tags'])
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst()

  if (!row || String(row.state) !== 'active')
    return null

  // Seen, whether or not it is given work. A list of runners is a list of
  // machines somebody is paying for, and "last seen three weeks ago" is the
  // only way to notice one that quietly stopped.
  await db
    .updateTable('runners')
    .set({ last_seen_at: new Date().toISOString() })
    .where('id', '=', Number(row.id))
    .execute()

  return {
    row,
    facts: {
      id: Number(row.id),
      state: String(row.state),
      scopeType: String(row.scope_type),
      scopeId: row.scope_id === null ? null : Number(row.scope_id),
      labels: splitLabels(row.labels),
      // What the machine said it is, which is what an `agents:` query selects on.
      tags: splitLabels(row.tags),
    },
  }
}

export interface AuthenticatedJob {
  jobId: number
  runner: RunnerFacts
}

/**
 * The job a per-claim token belongs to, and the runner holding it.
 *
 * Everything after the claim authenticates this way rather than with the
 * registration credential. The difference is what a leak costs: the
 * registration token is installed once, never rotated, and reaches every job
 * that machine may run, while this one is good for a single job and dies with
 * its lease.
 *
 * **The token identifies the job.** No job id is taken from the caller, so
 * there is no "token for job A, id for job B" to get wrong - the credential
 * *is* the claim on that job, which is the property the wrong-job case in
 * `protocol.ts` had to be defended against by hand.
 */
export async function authenticateJob(request: any): Promise<AuthenticatedJob | null> {
  const token = bearerFrom(request)
  if (!token)
    return null

  const job: any = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'runner_id', 'state'])
    .where('job_token_hash', '=', hashToken(token))
    .executeTakeFirst()

  if (!job?.runner_id)
    return null

  const runner: any = await db
    .selectFrom('runners')
    .select(['id', 'state', 'scope_type', 'scope_id', 'labels', 'tags'])
    .where('id', '=', Number(job.runner_id))
    .executeTakeFirst()

  // A runner disabled mid-job stops being believed immediately, rather than
  // when its lease happens to lapse. Turning one off is something an operator
  // does *because* they want it to stop.
  if (!runner || String(runner.state) !== 'active')
    return null

  await db
    .updateTable('runners')
    .set({ last_seen_at: new Date().toISOString() })
    .where('id', '=', Number(runner.id))
    .execute()

  return {
    jobId: Number(job.id),
    runner: {
      id: Number(runner.id),
      state: String(runner.state),
      scopeType: String(runner.scope_type),
      scopeId: runner.scope_id === null ? null : Number(runner.scope_id),
      labels: splitLabels(runner.labels),
      tags: splitLabels(runner.tags),
    },
  }
}
