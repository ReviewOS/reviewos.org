/**
 * Record what a runner says happened.
 *
 * Whether its word counts at all is [protocol.ts](./protocol.ts)'s decision.
 * This applies it, and then does the part the runner cannot: work out what the
 * *run* now is, unblock whatever was waiting on this job, and skip whatever can
 * no longer happen.
 *
 * That last part is [`Workflow/settle.ts`](../Workflow/settle.ts), shared with
 * the sweep. A report is not the only thing that moves a run's graph, and two
 * copies of "what does this failure unblock" is how the two paths end up
 * disagreeing about the same run.
 */

import { db } from '@stacksjs/database'
import { secretsOfJob } from './logs'
import { redactSecrets } from './redact'
import { announceJob, announceRunIfMoved } from '../Workflow/announce'
import type { JobState } from '../Workflow/states'
import { canJobMove } from '../Workflow/states'
import { revokeJobTokens } from '../Workflow/jobToken'
import { softFailOutcome } from '../Workflow/stepAttributes'
import { settleRun } from '../Workflow/settle'
import type { RunnerFacts } from './protocol'
import { mayReport, splitLabels } from './protocol'

export interface ReportInput {
  jobId: number
  /** What the runner says the job came to. */
  state: 'succeeded' | 'failed' | 'cancelled'
  /** Optional, and untrusted: a runner can send anything. */
  error?: string | null
  /**
   * What the failing step exited with, when the runner knows.
   *
   * Sent so `retry: { exit-status: [137] }` can mean something. A test suite
   * that exits 1 on a failed assertion is not worth running again; a step
   * killed for memory at 137, or a fetch that exits 7, is exactly what a retry
   * is for, and the number is the only thing that tells them apart.
   */
  exitStatus?: number | null
  /**
   * What the job produced, resolved by the runner from its steps.
   *
   * Untrusted like everything else a runner says, and capped: a job's outputs
   * are read by the jobs after it, so an unbounded map is a way to make every
   * later claim expensive.
   */
  outputs?: Record<string, string> | null
}

/**
 * A job's outputs, bounded.
 *
 * Sixty-four values of four kilobytes each is more than any real job produces
 * and far less than a runner could send. The cap is here rather than only in the
 * endpoint because this is the function that writes the row, and a limit that
 * lives away from the write is a limit somebody bypasses by calling the other
 * path.
 */
async function cappedOutputs(
  outputs: Record<string, string> | null | undefined,
  jobId: number,
): Promise<string | null> {
  if (!outputs || typeof outputs !== 'object')
    return null

  /*
   * Redacted here for the same reason a log chunk is: the runner masking its
   * own outputs is the first line, and the first line is somebody else's
   * program. An output is the worse of the two to get wrong - a log is read by
   * a person, and an output is put into the environment of every job that
   * declares `needs` on this one, which is a secret leaving the job it was
   * scoped to.
   *
   * A workflow that wants a secret in a later job asks for the secret there.
   */
  const secrets = await secretsOfJob(jobId)
  const values: Record<string, string> = {}

  for (const [name, value] of Object.entries(outputs).slice(0, 64)) {
    if (!name)
      continue

    values[name.slice(0, 200)] = redactSecrets(String(value ?? ''), secrets).slice(0, 4000)
  }

  return Object.keys(values).length > 0 ? JSON.stringify(values) : null
}

export interface ReportOutcome {
  ok: boolean
  reason: string
  duplicate: boolean
  /** The run's state after this report, when the report was accepted. */
  runState?: string
}

/** A runner can send as much as it likes; the column cannot take it. */
function trimmed(value: string | null | undefined, limit = 4000): string | null {
  const text = String(value ?? '').trim()
  if (!text)
    return null

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export async function reportJob(
  runner: RunnerFacts,
  input: ReportInput,
  now: Date = new Date(),
): Promise<ReportOutcome> {
  const row = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.state as state',
      'workflow_jobs.runs_on as runs_on',
      'workflow_jobs.runner_id as runner_id',
      'workflow_jobs.lease_expires_at as lease_expires_at',
      'workflow_jobs.settings as settings',
      'workflow_jobs.workflow_run_id as run_id',
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    .where('workflow_jobs.id', '=', input.jobId)
    .executeTakeFirst()

  if (!row)
    return { ok: false, reason: 'no such job', duplicate: false }

  const facts = {
    id: Number(row.id),
    state: String(row.state),
    runsOn: splitLabels(row.runs_on === null || row.runs_on === undefined ? null : String(row.runs_on)),
    repositoryId: Number(row.repository_id),
    ownerId: Number(row.owner_id),
    runnerId: row.runner_id === null ? null : Number(row.runner_id),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    /** The `reviewos:` attributes the run copied forward, for `soft-fail:`. */
    settings: row.settings ?? null,
  }

  // The state the runner is claiming travels with the question, because one
  // answer depends on it: a cancellation may be acknowledged with a lease that
  // was revoked, and nothing else may.
  const allowed = mayReport(runner, facts, now, { reporting: input.state })
  if (!allowed.ok)
    return { ok: false, reason: allowed.reason, duplicate: false }

  if (allowed.duplicate) {
    // Already recorded by this runner. Answered as success, because from the
    // runner's side it was - refusing is how a correct runner retries forever.
    return { ok: true, reason: allowed.reason, duplicate: true, runState: await currentRunState(Number(row.run_id)) }
  }

  if (!canJobMove(facts.state as JobState, input.state))
    return { ok: false, reason: `a job that is ${facts.state} cannot become ${input.state}`, duplicate: false }

  /*
   * A failure the workflow asked to have retried goes back to the queue
   * instead of ending the job.
   *
   * Before the write below, because the two are alternatives: a job that is
   * about to run again has not failed, and recording a failure first would put
   * a red cross on a commit for something the workflow said to expect.
   */
  if (input.state === 'failed') {
    const retry = await retryDecision(facts.id, input.exitStatus ?? null)

    if (retry.retrying) {
      await db
        .updateTable('workflow_jobs')
        .set({
          state: 'queued',
          attempt: retry.attempt,
          runner_id: null,
          lease_expires_at: null,
          // The dead attempt's credential goes with it: the next attempt mints
          // its own, and a token from a finished attempt must not be able to
          // report over the one that replaced it.
          job_token_hash: null,
          started_at: null,
          // A retry waits for a machine again, so its wait starts again. The
          // alternative reports the first attempt's wait twice.
          queued_at: new Date().toISOString(),
          condition_reason: retry.reason,
        })
        .where('id', '=', facts.id)
        .where('runner_id', '=', String(runner.id))
        .execute()

      return { ok: true, reason: retry.reason, duplicate: false, runState: await currentRunState(Number(row.run_id)) }
    }
  }

  /*
   * `soft-fail:` - a failure the workflow said to tolerate.
   *
   * Decided here rather than at dispatch because it keys on the exit status,
   * which does not exist until the job has failed. The job's *own* state stays
   * `failed`, and `continue_on_error` is what the graph reads - so the run goes
   * on, the commit does not go red, and the job still says what happened.
   *
   * Recorded as a failure rather than rewritten as a success on purpose: a
   * screen that shows a tolerated failure as passing is one where nobody ever
   * finds out the linter has been failing for a month.
   */
  const soft = softFailOf(facts.settings)
  const tolerated = input.state === 'failed'
    ? softFailOutcome(soft, input.exitStatus ?? null)
    : { tolerated: false, reason: '' }

  if (tolerated.tolerated) {
    await db
      .updateTable('workflow_jobs')
      .set({ continue_on_error: true, condition_reason: tolerated.reason })
      .where('id', '=', facts.id)
      .execute()
      .catch(() => null)
  }

  await db
    .updateTable('workflow_jobs')
    .set({
      state: input.state,
      finished_at: now.toISOString(),
      /*
       * The outputs travel with the conclusion rather than in a call of their
       * own.
       *
       * A job that reported outputs and then failed to report its result would
       * leave values attached to a job nobody can tell finished, and the jobs
       * waiting on it would read them without knowing whether the job that
       * produced them succeeded.
       */
      outputs: await cappedOutputs(input.outputs, input.jobId),
      // The lease is released with the result. Leaving it would let a
      // heartbeat from this runner keep a finished job looking held.
      lease_expires_at: null,

      // The job token is **kept**, and that is deliberate.
      //
      // Clearing it here was the first instinct and it is wrong: delivery is
      // at-least-once, so a runner that did not hear this answer will report
      // again with the same credential, and a cleared token turns that into a
      // 401. The runner then cannot tell whether its work was recorded, which
      // is precisely the ambiguity the duplicate answer exists to remove.
      //
      // Nothing is bought by clearing it either. The job is terminal, and
      // `mayReport` will not move a terminal job - so the token's entire
      // remaining power is to be told "already recorded". It goes when the
      // lease is reclaimed by the sweep, which is the case where the work
      // really did move to somebody else.
    })
    .where('id', '=', facts.id)
    .where('runner_id', '=', String(runner.id))
    .execute()

  if (input.error) {
    await db
      .insertInto('workflow_step_attempts')
      .values({
        workflow_step_id: null,
        repository_id: facts.repositoryId,
        attempt: 1,
        state: input.state === 'succeeded' ? 'succeeded' : 'failed',
        runner_id: String(runner.id),
        error: trimmed(input.error),
        finished_at: now.toISOString(),
      })
      .execute()
      .catch(() => null)
  }

  /*
   * The job's API token dies with the job.
   *
   * Revoked here rather than left to expire, because an hour is a long time
   * for a credential nothing needs any more - and the expiry stays as the
   * backstop for the runner that dies without reporting, which is the case
   * this line cannot cover.
   */
  await revokeJobTokens(Number(row.run_id), Number(row.id), now)

  const before = await currentRunState(Number(row.run_id))
  const runState = await settleRun(Number(row.run_id), now)

  /*
   * The two events a program waits on, after the write and in that order: the
   * job it was told about, then the run if this report finished it. A receiver
   * that hears "run succeeded" before "job succeeded" has to hold the first
   * until the second arrives to make sense of it.
   */
  const named = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select([
      'workflow_jobs.job_id as job_id',
      'workflow_jobs.name as name',
      'workflow_runs.number as run_number',
    ])
    .where('workflow_jobs.id', '=', facts.id)
    .executeTakeFirst()

  await announceJob(facts.repositoryId, {
    id: facts.id,
    jobId: String(named?.job_id ?? ''),
    name: named?.name ? String(named.name) : String(named?.job_id ?? ''),
    state: input.state,
    runId: Number(row.run_id),
    runNumber: Number(named?.run_number ?? 0),
    runnerId: String(runner.id),
  })

  await announceRunIfMoved(facts.repositoryId, Number(row.run_id), before, runState)

  return { ok: true, reason: 'recorded', duplicate: false, runState }
}

async function currentRunState(runId: number): Promise<string> {
  const run = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? 'queued')
}

/**
 * Whether this failure is one the workflow asked to have run again.
 *
 * Three things have to line up, and all three are the workflow's own statement:
 * it asked for retries, it has attempts left, and - when it named exit
 * statuses - this is one of them. Anything else is an ordinary failure, which
 * is the direction that keeps a broken build visible.
 */
async function retryDecision(jobId: number, exitStatus: number | null): Promise<{ retrying: boolean, attempt: number, reason: string }> {
  const job = await db
    .selectFrom('workflow_jobs')
    .select(['attempt', 'settings'])
    .where('id', '=', jobId)
    .executeTakeFirst()

  const attempt = Number(job?.attempt ?? 1)

  let retry: any = null

  try {
    retry = JSON.parse(String(job?.settings ?? '{}'))?.retry ?? null
  }
  catch {
    retry = null
  }

  const allowed = Number(retry?.attempts ?? 0)

  if (!Number.isInteger(allowed) || allowed < 1)
    return { retrying: false, attempt, reason: '' }

  // `attempts: 2` means two *extra* tries, so three runs in total.
  if (attempt > allowed)
    return { retrying: false, attempt, reason: '' }

  const statuses = Array.isArray(retry?.exitStatus) ? retry.exitStatus.map(Number) : []

  if (statuses.length > 0 && (exitStatus === null || !statuses.includes(exitStatus))) {
    /*
     * A workflow that named statuses is saying which failures are worth
     * repeating. An unknown status is not one of them: retrying on "we do not
     * know why it failed" is how a narrow retry becomes a blanket one.
     */
    return { retrying: false, attempt, reason: '' }
  }

  return {
    retrying: true,
    attempt: attempt + 1,
    reason: `Attempt ${attempt} failed${exitStatus === null ? '' : ` (exit ${exitStatus})`}; retrying, ${allowed - attempt + 1} of ${allowed} left.`,
  }
}

/** A job's `soft-fail:`, out of the settings the run copied forward. */
function softFailOf(settings: unknown): { any: boolean, statuses: number[] } | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))
    const soft = parsed?.softFail

    if (!soft || typeof soft !== 'object')
      return null

    return {
      any: soft.any === true,
      statuses: Array.isArray(soft.statuses) ? soft.statuses.map(Number).filter(Number.isFinite) : [],
    }
  }
  catch {
    return null
  }
}
