/**
 * Move a run's graph forward, from wherever it now is.
 *
 * Four decisions, in an order that matters: stop the matrix combinations a
 * `fail-fast` failure takes with it, skip whatever can no longer run, queue
 * whatever has just been unblocked, and then say what the run itself is.
 *
 * **It lives here rather than in the reporter because two things move a run.** A
 * report is one; the sweep that force-cancels an unacknowledged job or reclaims
 * a dead runner's work is the other, and it used to recompute only the run's
 * state. So a job the sweep cancelled left its dependants in `blocked` forever,
 * and a run with a blocked job never reaches a terminal state - a pull request
 * whose checks stay pending on work that ended an hour ago.
 *
 * Derived from the rows rather than accumulated, so a control plane that
 * restarted mid-run reaches the same answer as one that watched every
 * transition.
 */

import { db } from '@stacksjs/database'
import type { JobState } from './states'
import { effectiveState, eligibleJobs, failFastCasualties, runStateFromJobs, unreachableJobs } from './states'

/**
 * What a job cancelled by a sibling is told, on its own row.
 *
 * A cancelled job with no reason is the worst row on a run page: no logs, no
 * failure, no explanation, and the obvious guess - that somebody pressed
 * cancel - is wrong. `fail-fast` is a decision the workflow made, so it says so
 * where the decision landed.
 *
 * Plain prose, no markup: it is rendered as text on the run page, and backticks
 * that read as code in a file read as typing mistakes on a screen.
 */
export const FAIL_FAST_REASON = 'Stopped because another combination of this matrix failed and fail-fast is on.'

async function jobsOfRun(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs', 'continue_on_error', 'fail_fast'])
    .where('workflow_run_id', '=', runId)
    .execute()
}

/**
 * The run's jobs in the shape the graph reads, ids and all.
 *
 * The id travels with the row rather than being looked up afterwards, and that
 * is a fix rather than a tidy-up: this used to find the row to move by matching
 * `job_id`, which finds *one* row per name - so a matrix of four had three
 * combinations that could never be unblocked or skipped.
 */
function graphRows(jobs: readonly any[]): Array<{
  id: number
  job_id: string
  state: JobState
  needs: string | null
  continue_on_error: boolean
  fail_fast: boolean
}> {
  return jobs.map(job => ({
    id: Number(job.id),
    job_id: String(job.job_id),
    state: String(job.state) as JobState,
    needs: job.needs ?? null,
    continue_on_error: job.continue_on_error === true,
    fail_fast: job.fail_fast !== false,
  }))
}

/** The run's state after settling it, which is what the caller announces. */
export async function settleRun(runId: number, now: Date = new Date()): Promise<string> {
  let jobs = await jobsOfRun(runId)

  /*
   * `fail-fast` first, because it decides what the rest of the graph is looking
   * at: a combination this stops is one nothing downstream should be unblocked
   * by, and running it in the other order would queue a job for a matrix that
   * is already being torn down.
   */
  const casualties = failFastCasualties(graphRows(jobs))

  for (const job of casualties.cancel) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now.toISOString(), condition_reason: FAIL_FAST_REASON } as any)
      .where('id', '=', job.id)
      .where('state', 'in', ['blocked', 'queued'])
      .execute()
  }

  for (const job of casualties.stop) {
    /*
     * A combination already on a machine is asked to stop, not declared
     * stopped - the same cooperative shape as cancelling a run, and for the
     * same reason: this instance does not control the machine. The lease is
     * revoked in the same write, so whatever holds it can no longer report a
     * result over a decision that has been made.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling', lease_expires_at: now.toISOString(), condition_reason: FAIL_FAST_REASON } as any)
      .where('id', '=', job.id)
      .where('state', '=', 'running')
      .execute()
  }

  if (casualties.cancel.length > 0 || casualties.stop.length > 0)
    jobs = await jobsOfRun(runId)

  // Anything that can never run now, so the run can finish rather than wait on
  // a job whose dependency failed.
  const unreachable = unreachableJobs(graphRows(jobs))

  for (const job of unreachable) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'skipped', finished_at: now.toISOString() } as any)
      .where('id', '=', job.id)
      .where('state', '=', 'blocked')
      .execute()
  }

  if (unreachable.length > 0)
    jobs = await jobsOfRun(runId)

  // And anything whose dependencies have now all succeeded.
  const ready = eligibleJobs(graphRows(jobs))

  for (const job of ready) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'queued' } as any)
      .where('id', '=', job.id)
      .where('state', '=', 'blocked')
      .execute()
  }

  const settled = await jobsOfRun(runId)
  const state = runStateFromJobs(graphRows(settled).map(effectiveState))

  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  const from = String(run?.state ?? 'queued')

  // A finished run must never move again, whatever the rows now say. A late
  // report or a sweep reopening a conclusion is the one outcome a branch
  // protection rule must not be told about.
  if (['succeeded', 'failed', 'cancelled'].includes(from))
    return from

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
      // Guarded on the state it was read at, so a concurrent report cannot have
      // this one overwrite a conclusion with a staler one.
      .where('state', '=', from)
      .execute()
  }

  return state
}
