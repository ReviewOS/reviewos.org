/**
 * Record what a runner says happened.
 *
 * Whether its word counts at all is [protocol.ts](./protocol.ts)'s decision.
 * This applies it, and then does the part the runner cannot: work out what the
 * *run* now is, unblock whatever was waiting on this job, and skip whatever can
 * no longer happen.
 *
 * That last one matters more than it reads. A job whose dependency failed sits
 * in `blocked` forever unless something moves it, and a run with a blocked job
 * never reaches a terminal state - which means a pull request whose checks
 * never resolve, holding a merge open on work that stopped minutes ago.
 */

import { db } from '@stacksjs/database'
import type { JobState } from '../Workflow/states'
import { canJobMove, eligibleJobs, runStateFromJobs, unreachableJobs } from '../Workflow/states'
import type { RunnerFacts } from './protocol'
import { mayReport, splitLabels } from './protocol'

export interface ReportInput {
  jobId: number
  /** What the runner says the job came to. */
  state: 'succeeded' | 'failed' | 'cancelled'
  /** Optional, and untrusted: a runner can send anything. */
  error?: string | null
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

  const allowed = mayReport(runner, facts, now)
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
      // The lease is released with the result. Leaving it would let a
      // heartbeat from this runner keep a finished job looking held.
      lease_expires_at: null,
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

  const runState = await settleRun(Number(row.run_id), now)

  return { ok: true, reason: 'recorded', duplicate: false, runState }
}

async function jobsOfRun(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs'])
    .where('workflow_run_id', '=', runId)
    .execute()
}

async function currentRunState(runId: number): Promise<string> {
  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? 'queued')
}

/**
 * Move everything this job's result unblocked, and close the run if it is done.
 *
 * Derived from the jobs rather than accumulated, so a control plane that
 * restarted mid-run reaches the same answer as one that watched every
 * transition. An accumulated status is a second source of truth that drifts.
 */
async function settleRun(runId: number, now: Date): Promise<string> {
  let jobs = await jobsOfRun(runId)

  // Anything that can never run now, so the run can finish rather than wait on
  // a job whose dependency failed.
  const unreachable = unreachableJobs(jobs.map(job => ({
    job_id: String(job.job_id),
    state: String(job.state) as JobState,
    needs: job.needs,
  })))

  for (const job of unreachable) {
    const id = jobs.find(row => String(row.job_id) === job.job_id)?.id
    if (id === undefined)
      continue

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'skipped', finished_at: now.toISOString() } as any)
      .where('id', '=', Number(id))
      .where('state', '=', 'blocked')
      .execute()
  }

  if (unreachable.length > 0)
    jobs = await jobsOfRun(runId)

  // And anything whose dependencies have now all succeeded.
  const ready = eligibleJobs(jobs.map(job => ({
    job_id: String(job.job_id),
    state: String(job.state) as JobState,
    needs: job.needs,
  })))

  for (const job of ready) {
    const id = jobs.find(row => String(row.job_id) === job.job_id)?.id
    if (id === undefined)
      continue

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'queued' } as any)
      .where('id', '=', Number(id))
      .where('state', '=', 'blocked')
      .execute()
  }

  const settled = await jobsOfRun(runId)
  const state = runStateFromJobs(settled.map(job => String(job.state) as JobState))

  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  const from = String(run?.state ?? 'queued')

  if (from !== state) {
    await db
      .updateTable('workflow_runs')
      .set({
        state,
        ...(state === 'succeeded' || state === 'failed' || state === 'cancelled'
          ? { finished_at: now.toISOString() }
          : {}),
      } as any)
      .where('id', '=', runId)
      // The run must not move backwards out of a terminal state, and the write
      // is guarded on the state it was read at so a concurrent report cannot
      // overwrite a conclusion with a staler one.
      .where('state', '=', from)
      .execute()
  }

  return state
}
