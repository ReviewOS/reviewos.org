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
import { announceJob, announceRunIfMoved } from '../Workflow/announce'
import type { JobState } from '../Workflow/states'
import { canJobMove } from '../Workflow/states'
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
function cappedOutputs(outputs: Record<string, string> | null | undefined): string | null {
  if (!outputs || typeof outputs !== 'object')
    return null

  const values: Record<string, string> = {}

  for (const [name, value] of Object.entries(outputs).slice(0, 64)) {
    if (!name)
      continue

    values[name.slice(0, 200)] = String(value ?? '').slice(0, 4000)
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
  const row: any = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.state as state',
      'workflow_jobs.runs_on as runs_on',
      'workflow_jobs.runner_id as runner_id',
      'workflow_jobs.lease_expires_at as lease_expires_at',
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
    runsOn: splitLabels(row.runs_on),
    repositoryId: Number(row.repository_id),
    ownerId: Number(row.owner_id),
    runnerId: row.runner_id === null ? null : Number(row.runner_id),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
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
      outputs: cappedOutputs(input.outputs),
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
    } as any)
    .where('id', '=', facts.id)
    .where('runner_id', '=', String(runner.id))
    .execute()

  if (input.error) {
    await db
      .insertInto('workflow_step_attempts')
      .values({
        workflow_step_id: null,
        attempt: 1,
        state: input.state === 'succeeded' ? 'succeeded' : 'failed',
        runner_id: String(runner.id),
        error: trimmed(input.error),
        finished_at: now.toISOString(),
      } as any)
      .execute()
      .catch(() => null)
  }

  const before = await currentRunState(Number(row.run_id))
  const runState = await settleRun(Number(row.run_id), now)

  /*
   * The two events a program waits on, after the write and in that order: the
   * job it was told about, then the run if this report finished it. A receiver
   * that hears "run succeeded" before "job succeeded" has to hold the first
   * until the second arrives to make sense of it.
   */
  const named: any = await db
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
  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? 'queued')
}
