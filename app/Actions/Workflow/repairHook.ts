/**
 * The opt-in failure hook: whether a failed job starts a repair, and the
 * bookkeeping that makes the answer visible afterwards.
 *
 * **Nothing here talks to a model.** This is the control plane - it reads the
 * repository's policy, counts what the run has already spent, asks
 * `mayAttemptRepair`, and either writes a refusal or puts a job on the queue.
 * The agent is what that job runs, and keeping the two apart is what lets the
 * whole decision be tested without a network.
 *
 * ## It never touches the failing run
 *
 * The roadmap's line is "the original run remains failed", and the way to be
 * sure of that is for this file to have no means of changing it. It reads the
 * run and writes only to `repair_attempts`. A repair that could mark its own
 * trigger green would be the failure mode the policy exists to prevent, wearing
 * a different hat.
 *
 * ## Called after the run is settled, and never on the retry path
 *
 * `report.ts` calls this once the job's conclusion is durable and the graph has
 * moved. Earlier would mean repairing a job that is about to be retried, which
 * spends a budget on a failure the workflow already said it expects to see
 * again.
 */

import { db } from '@stacksjs/database'
import { auditEvent } from '../../Audit/events'
import { isTrue } from '../Support/sql'
import { mayAttemptRepair, repairPolicyFor } from './repairPolicy'
import { recordAttempt, spentOn } from './repairAttempts'

export interface RepairTrigger {
  /** The job row's own id, which is what the runner reported against. */
  jobId: number
  runId: number
  repositoryId: number
  /** Whether the workflow said to tolerate this failure. */
  tolerated?: boolean
}

export type RepairDecision =
  | { started: false, reason: string, refusal?: string }
  | { started: true, attemptId: number, step: string }

/**
 * Consider a failed job for repair, and start one if the policy allows it.
 *
 * Never throws. This runs at the end of a runner's report, and a report that
 * failed because the repair hook could not read a table is a job whose result
 * was lost to a feature nobody turned on.
 */
export async function considerRepair(trigger: RepairTrigger): Promise<RepairDecision> {
  try {
    return await decide(trigger)
  }
  catch (error) {
    console.error('[repair] the failure hook could not run:', error)

    return { started: false, reason: 'the failure hook could not run' }
  }
}

async function decide(trigger: RepairTrigger): Promise<RepairDecision> {
  /*
   * A tolerated failure is not repaired.
   *
   * `continue_on_error` is the workflow saying this red step is acceptable, and
   * the run went on without it. Spending a repair budget on something nobody is
   * blocked by is the wrong use of a ceiling that exists to be scarce.
   */
  if (trigger.tolerated)
    return { started: false, reason: 'the workflow tolerates this failure' }

  const policy = await repairPolicyFor(trigger.repositoryId)

  /*
   * The cheapest question first, and it is the one that is almost always the
   * answer. Repair is off by default, so on an ordinary instance this hook is a
   * single indexed read on a table with no rows in it.
   */
  if (!policy.enabled)
    return { started: false, reason: 'automated repair is not enabled', refusal: 'not-enabled' }

  const step = await failedStepOf(trigger.jobId)

  if (!step)
    return { started: false, reason: 'no failed step to repair' }

  const spend = await spentOn(trigger.runId)

  const verdict = mayAttemptRepair({
    policy,
    step,
    attempts: spend.attempts,
    minutesSpent: spend.minutesSpent,
    costSpent: spend.costSpent,
  })

  if (!verdict.ok) {
    /*
     * Written down, including "not enabled for this step".
     *
     * The question this table gets asked is "why did nothing try to fix this",
     * and a refusal nobody recorded makes the repository whose budget was spent
     * look exactly like the one nothing ever noticed.
     */
    await recordAttempt({
      repositoryId: trigger.repositoryId,
      runId: trigger.runId,
      jobId: trigger.jobId,
      step,
      state: 'refused',
      refusal: verdict.refusal ?? null,
      reason: verdict.reason ?? null,
    })

    await auditEvent('workflow:repair-refused', {
      subject: { type: 'repository', id: trigger.repositoryId },
      actorId: null,
      repositoryId: trigger.repositoryId,
      reason: verdict.reason ?? null,
      detail: { run_id: trigger.runId, job_id: trigger.jobId, step, refusal: verdict.refusal ?? null },
    }).catch(() => null)

    return { started: false, reason: verdict.reason ?? 'refused', refusal: verdict.refusal }
  }

  /*
   * The row goes in **before** the job is queued, and its id travels with the
   * job.
   *
   * Written after dispatch, an attempt would not exist during the window where
   * a second failure on the same run reads the budget - and two agents would
   * work on one run, each believing it was the first. This ordering costs an
   * insert on the path that was going to spend a model call anyway.
   */
  const attemptId = await recordAttempt({
    repositoryId: trigger.repositoryId,
    runId: trigger.runId,
    jobId: trigger.jobId,
    step,
    state: 'attempted',
  })

  if (!attemptId) {
    /*
     * No ledger row, no repair. The budgets are counted from this table, so an
     * attempt that could not be written is one nothing can bound - and an
     * unbounded repair loop is the thing the ceilings exist to stop.
     */
    return { started: false, reason: 'the repair could not be recorded, so it was not started' }
  }

  const { default: RepairJob } = await import('../../Jobs/RepairJob')

  await RepairJob.dispatch({
    attemptId,
    repositoryId: trigger.repositoryId,
    runId: trigger.runId,
    jobId: trigger.jobId,
    step,
  })

  await auditEvent('workflow:repair-attempted', {
    subject: { type: 'repository', id: trigger.repositoryId },
    actorId: null,
    repositoryId: trigger.repositoryId,
    detail: { run_id: trigger.runId, job_id: trigger.jobId, step, attempt_id: attemptId },
  }).catch(() => null)

  return { started: true, attemptId, step }
}

/**
 * The name of the step this job failed on.
 *
 * The policy's `steps` list is an allowlist of names, and the runner reports
 * positions - so the name has to come from the stored step rather than from
 * anything the runner said. That is also the safer direction: a runner naming
 * its own step could name one the repository allows and get a repair on a step
 * it does not.
 *
 * The first failed step, by position, because that is the one that broke the
 * job; the steps after it either did not run or ran on a workspace it left.
 */
export async function failedStepOf(jobId: number): Promise<string | null> {
  const row: any = await db
    .selectFrom('workflow_steps')
    .select(['name', 'position', 'continue_on_error'])
    .where('workflow_job_id', '=', jobId)
    .where('state', '=', 'failed')
    .orderBy('position', 'asc')
    .executeTakeFirst()
    .catch(() => null)

  if (!row)
    return null

  // A step the workflow tolerates is not what failed the job, even when it is
  // the first red one in the list.
  if (isTrue(row.continue_on_error))
    return null

  const name = String(row.name ?? '').trim()

  return name || null
}
