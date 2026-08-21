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
import { leaseIsLive, splitLabels } from './protocol'

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
export function bearerFrom(request: RequestInstance): string {
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
export async function authenticateRunner(request: RequestInstance): Promise<AuthenticatedRunner | null> {
  const token = bearerFrom(request)
  if (!token)
    return null

  const row = await db
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

export interface AuthenticateJobOptions {
  /**
   * Let the reporting endpoint inspect a terminal or revoked claim.
   *
   * Reporting has two protocol exceptions that need the old credential: an
   * at-least-once duplicate is answered as already recorded, and a runner may
   * acknowledge `cancelled` after cancellation deliberately revoked its lease.
   * `reportJob` applies those narrower rules. No other runner endpoint gets
   * this exception.
   */
  allowInactiveLease?: boolean
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
export async function authenticateJob(
  request: RequestInstance,
  options: AuthenticateJobOptions = {},
): Promise<AuthenticatedJob | null> {
  const token = bearerFrom(request)
  if (!token)
    return null

  const job = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'runner_id', 'state', 'lease_expires_at'])
    .where('job_token_hash', '=', hashToken(token))
    .executeTakeFirst()

  if (!job?.runner_id)
    return null

  /*
   * The job credential dies with its lease, for every endpoint, not only for
   * heartbeats and conclusions.
   *
   * Cancellation expires a lease before the runner has necessarily stopped.
   * Without this check, that runner could no longer publish a green result but
   * could still upload an artifact, poison a cache, append a log, annotate a
   * check or mint an identity token during the exact window revocation exists
   * to close.
   */
  if (!options.allowInactiveLease) {
    const active = String(job.state) === 'running' && leaseIsLive({
      leaseExpiresAt: job.lease_expires_at ? String(job.lease_expires_at) : null,
    }, new Date())

    if (!active)
      return null
  }

  const runner = await db
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
