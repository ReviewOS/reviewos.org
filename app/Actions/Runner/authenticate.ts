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
import { runnerJson } from './gate'
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

/** Why a job credential is no longer accepted, as the runner should hear it. */
export interface JobCredentialRefusal {
  /** 409 when the credential names a job this runner held, 401 when it names nothing. */
  status: 401 | 409
  error: string
  fix?: string
}

/**
 * Why `authenticateJob` refused a credential, in words the runner can act on.
 *
 * Every job endpoint used to answer a refused credential with "401 Unknown job
 * credential", whatever the reason. That was true only of a token that names
 * no job. A job the instance stopped on purpose - its run cancelled, or past
 * its `timeout-minutes` - still has its token on the row (the report endpoint
 * needs it to accept the acknowledgement), and its runner was told "unknown"
 * and wrote that down as the job's error. HQ's `api-e2e` ended "The instance
 * revoked this job's lease: 401 Unknown job credential" five times between
 * 2026-11-06 and 2026-11-08, and each one was read as a credential bug, a
 * deploy restart or a concurrency group cancelling the wrong run. Every one was the
 * job's own `timeout-minutes: 40`, which the row said and the runner never
 * heard.
 *
 * So a token that matches a job answers 409 with the instance's own reason,
 * the same status the heartbeat already uses for "this job is no longer
 * yours". Only the holder of the token learns it: the token is 32 random bytes
 * and is compared by hash, so telling its holder why the job ended tells
 * nobody anything about tokens they do not have.
 */
export async function jobCredentialRefusal(request: RequestInstance, now: Date = new Date()): Promise<JobCredentialRefusal> {
  const unknown: JobCredentialRefusal = { status: 401, error: 'Unknown job credential' }
  const token = bearerFrom(request)
  if (!token)
    return unknown

  const job: any = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id', 'runner_id', 'state', 'lease_expires_at', 'condition_reason'])
    .where('job_token_hash', '=', hashToken(token))
    .executeTakeFirst()
    .catch(() => null)

  if (!job?.runner_id)
    return unknown

  const stop = 'Stop working on it; anything reported now is refused.'
  const state = String(job.state ?? '')

  if (state === 'cancelling' || state === 'cancelled') {
    const own = String(job.condition_reason ?? '').trim()
    let reason = own

    if (!reason) {
      const run: any = await db
        .selectFrom('workflow_runs')
        .select(['conclusion_reason'])
        .where('id', '=', Number(job.workflow_run_id))
        .executeTakeFirst()
        .catch(() => null)
      reason = String(run?.conclusion_reason ?? '').trim() || 'Its run was cancelled.'
    }

    return { status: 409, error: reason, fix: stop }
  }

  if (state !== 'running')
    return { status: 409, error: `This job already finished as ${state || 'unknown'}.`, fix: stop }

  if (!leaseIsLive({ leaseExpiresAt: job.lease_expires_at ? String(job.lease_expires_at) : null }, now)) {
    return {
      status: 409,
      error: 'This job\'s lease lapsed before the instance heard from this runner again.',
      fix: 'Stop working on it. The instance may give it to another machine.',
    }
  }

  const runner: any = await db
    .selectFrom('runners')
    .select(['state'])
    .where('id', '=', Number(job.runner_id))
    .executeTakeFirst()
    .catch(() => null)

  if (String(runner?.state ?? '') !== 'active')
    return { status: 409, error: 'This runner was disabled while it held the job.', fix: stop }

  return unknown
}

/** The answer for a refused job credential: 409 with the reason when there is one, 401 otherwise. */
export async function refuseJobCredential(request: RequestInstance): Promise<Response> {
  const refusal = await jobCredentialRefusal(request)
  const { status, ...body } = refusal

  return runnerJson(body, status)
}

/**
 * Whether `token` is the credential of a job that is running now, on an
 * active runner, for this repository - so it may read that repository over
 * git's HTTP protocol.
 *
 * The job's own credential is the right thing to clone with: it names one
 * job, it dies with that job's lease, and it reaches exactly the repository
 * the job belongs to. A runner off the instance's host otherwise had nothing
 * to clone a private repository with - an operator-wide clone token reaches
 * every repository the runner might be handed, and a run with no actor (a
 * mirror's sync, a schedule) has no user token at all. Read only: the
 * caller asks this for `upload-pack`, never for a push.
 */
export async function jobMayRead(token: string, repositoryId: number, now: Date = new Date()): Promise<boolean> {
  if (!token)
    return false

  const job: any = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.runner_id as runner_id', 'workflow_jobs.state as state', 'workflow_jobs.lease_expires_at as lease_expires_at', 'workflow_runs.repository_id as repository_id'])
    .where('workflow_jobs.job_token_hash', '=', hashToken(token))
    .executeTakeFirst()
    .catch(() => null)

  if (!job?.runner_id || Number(job.repository_id) !== repositoryId)
    return false

  const live = String(job.state) === 'running' && leaseIsLive({
    leaseExpiresAt: job.lease_expires_at ? String(job.lease_expires_at) : null,
  }, now)

  if (!live)
    return false

  const runner = await db
    .selectFrom('runners')
    .select(['state'])
    .where('id', '=', Number(job.runner_id))
    .executeTakeFirst()

  return String(runner?.state ?? '') === 'active'
}
