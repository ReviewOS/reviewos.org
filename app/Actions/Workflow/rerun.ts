/**
 * Running a run again, without losing the run that failed.
 *
 * The button everybody presses, and the one this instance did not have. Every
 * decision here is about the same thing: **a re-run must not make the first
 * attempt unreadable.** Somebody re-runs a job to compare it against the
 * failure, and a system that overwrites the failure has thrown away the reason
 * they pressed it.
 *
 * So a re-run is not a second run. The commit, the workflow version and the
 * number are the same, and two rows would leave a reader guessing which was the
 * answer; it is a second *attempt*, which is what `GITHUB_RUN_ATTEMPT` means and
 * what every action naming a cache after it expects. The logs of the earlier
 * attempt keep their attempt number and stay where they are.
 */

import { db } from '@stacksjs/database'
import { settleRun } from './settle'

/** What to run again. */
export type RerunScope = 'all' | 'failed' | 'job'

export interface RerunCandidate {
  id: number
  job_id: string
  state: string
  needs?: string | null
  kind?: string | null
}

/**
 * Which jobs a re-run touches.
 *
 * Pure, because this is the decision people will argue about and the one a test
 * can pin: re-running "failed jobs" has to include the jobs that never ran
 * *because* those failed, or the second attempt reports a run that is still
 * missing half its work and calls it green.
 */
export function rerunPlan(input: {
  jobs: readonly RerunCandidate[]
  scope: RerunScope
  /** The job to re-run, for `scope: 'job'`. */
  jobKey?: string | null
}): RerunCandidate[] {
  if (input.scope === 'all')
    return [...input.jobs]

  const chosen = new Map<number, RerunCandidate>()

  const take = (job: RerunCandidate): void => {
    chosen.set(job.id, job)
  }

  if (input.scope === 'job') {
    for (const job of input.jobs) {
      if (String(job.job_id) === String(input.jobKey ?? ''))
        take(job)
    }
  }
  else {
    for (const job of input.jobs) {
      // `cancelled` counts as failed here: a job somebody stopped, or that
      // fail-fast stopped, is one nobody has an answer for.
      if (['failed', 'cancelled'].includes(String(job.state)))
        take(job)
    }
  }

  /*
   * And everything downstream of what was chosen.
   *
   * A job that was skipped because its dependency failed has no result, and
   * re-running only the failure would leave the run finishing with those jobs
   * still skipped - green, with half the pipeline never having run. Repeated to
   * a fixed point, because the graph is deeper than one layer.
   */
  for (let pass = 0; pass < 20; pass++) {
    const before = chosen.size

    for (const job of input.jobs) {
      if (chosen.has(job.id))
        continue

      const needs = String(job.needs ?? '').split('\n').map(one => one.trim()).filter(Boolean)

      if (needs.some(need => [...chosen.values()].some(one => String(one.job_id) === need)))
        take(job)
    }

    if (chosen.size === before)
      break
  }

  return [...chosen.values()]
}

/** The state a job goes back to: `queued` if nothing gates it, `blocked` if something does. */
export function resetState(job: RerunCandidate): 'queued' | 'blocked' {
  const needs = String(job.needs ?? '').split('\n').map(one => one.trim()).filter(Boolean)

  /*
   * The same rule the dispatcher uses when it creates the graph: anything the
   * control plane resolves itself - a barrier, a gate, a trigger - starts
   * blocked even with nothing to wait for, because `queued` means "a runner may
   * take this" and no runner may take those.
   */
  return needs.length > 0 || String(job.kind ?? 'command') !== 'command' ? 'blocked' : 'queued'
}

export interface RerunResult {
  ok: boolean
  /** The attempt number this run is now on. */
  attempt: number
  /** How many jobs went back into the graph. */
  jobs: number
  error?: string
  status?: number
}

/**
 * Run it again.
 *
 * Refuses a run that has not finished. Re-running a live run would mean two
 * attempts of the same job in flight, and the second one's report landing on a
 * row the first is still holding - the exact confusion the lease exists to
 * prevent.
 */
export async function rerunRun(input: {
  runId: number
  scope: RerunScope
  jobKey?: string | null
  now?: Date
}): Promise<RerunResult> {
  const now = input.now ?? new Date()

  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'attempt'])
    .where('id', '=', input.runId)
    .executeTakeFirst()

  if (!run)
    return { ok: false, attempt: 0, jobs: 0, error: 'No such run', status: 404 }

  if (!['succeeded', 'failed', 'cancelled'].includes(String(run.state))) {
    return {
      ok: false,
      attempt: Number(run.attempt ?? 1),
      jobs: 0,
      error: 'This run has not finished. Cancel it first, or wait for it.',
      status: 409,
    }
  }

  const jobs = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs', 'kind', 'attempt'])
    .where('workflow_run_id', '=', input.runId)
    .execute()

  const chosen = rerunPlan({ jobs, scope: input.scope, jobKey: input.jobKey })

  if (chosen.length === 0) {
    return {
      ok: false,
      attempt: Number(run.attempt ?? 1),
      jobs: 0,
      // Said rather than answered with a cheerful nothing: "re-run failed jobs"
      // on a run that did not fail is somebody looking at the wrong run.
      error: input.scope === 'job'
        ? 'This run has no job by that name.'
        : 'Nothing in this run failed, so there is nothing to run again.',
      status: 422,
    }
  }

  const attempt = Number(run.attempt ?? 1) + 1

  for (const job of chosen) {
    await db
      .updateTable('workflow_jobs')
      .set({
        state: resetState(job),
        /*
         * Everything the last attempt left behind goes with it. A row that kept
         * its runner or its lease would be claimable by the machine that held
         * it, and one that kept its outputs would hand a dependent job values
         * from a run that has been superseded.
         */
        attempt: Number((job as any).attempt ?? 1) + 1,
        runner_id: null,
        lease_expires_at: null,
        job_token_hash: null,
        queued_at: resetState(job) === 'queued' ? now.toISOString() : null,
        started_at: null,
        finished_at: null,
        outputs: null,
        condition_reason: null,
      })
      .where('id', '=', job.id)
      .execute()
  }

  await db
    .updateTable('workflow_runs')
    .set({ state: 'queued', attempt, finished_at: null, conclusion_reason: null })
    .where('id', '=', input.runId)
    .execute()

  // Settled straight away: a re-run whose first job is a barrier or a gate has
  // work for the control plane before any machine is involved.
  await settleRun(input.runId, now)

  return { ok: true, attempt, jobs: chosen.length }
}
