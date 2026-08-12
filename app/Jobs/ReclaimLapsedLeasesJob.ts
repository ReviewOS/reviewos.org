import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { runStateFromJobs } from '../Actions/Workflow/states'
import type { JobState } from '../Actions/Workflow/states'
import { announceRunIfMoved } from '../Actions/Workflow/announce'

/**
 * How long a runner is given to acknowledge a cancellation before it is made
 * for it.
 *
 * Cancellation is cooperative first: the work is on a machine this instance
 * does not control, and declaring it stopped before it has is a screen telling
 * somebody their build ended while it is still running and still costing them.
 * But a run that waits forever for an acknowledgement that is never coming is
 * worse - it holds a pull request's checks open on work that stopped minutes
 * ago, and it never reaches a terminal state.
 *
 * Two lease periods. Long enough that a runner mid-step gets its turn to say
 * so, short enough that nobody is watching a spinner for a build that has been
 * dead since before they opened the page.
 */
export const CANCEL_GRACE_SECONDS = 120

/**
 * Give back the work of runners that stopped talking.
 *
 * A lease lapsing is what frees a job from a machine that died - the machine
 * cannot say so, which is the whole reason leases exist. Until this job existed
 * that only happened when another runner *happened to ask* for work, so a
 * repository whose only runner crashed had a job stuck in `running` with nobody
 * coming to notice.
 *
 * Two reasons that is worse than it sounds. The run never reaches a terminal
 * state, so a pull request's checks stay pending on a machine that is gone; and
 * a fleet that is busy elsewhere never polls the queue that holds it, so the
 * failure is quietest exactly when the instance is most loaded.
 *
 * **Returned to `queued`, not failed.** A lapsed lease means the control plane
 * stopped hearing from a runner, which is not the same as the work having
 * failed - the job may even have succeeded, with the report lost on the way
 * back. Requeuing risks running it twice; failing it reports a verdict nobody
 * reached. At-least-once is the promise the protocol already makes, so the
 * first is the one that keeps it.
 */
export default new Job({
  name: 'ReclaimLapsedLeases',
  description: 'Return jobs whose runner stopped heartbeating to the queue',
  queue: 'default',
  tries: 1,

  async handle() {
    const now = new Date()

    // Done first, and separately: a job asked to stop is not a job to hand to
    // somebody else, and reclaiming it would put cancelled work back in the
    // queue for a second machine to run.
    const forced = await forceStalledCancellations(now)

    const lapsed: any[] = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id', 'runner_id', 'lease_expires_at'])
      .where('state', '=', 'running')
      // Anything held with no lease at all is lapsed by definition: a running
      // job without one is a row that lost its holder, and leaving it out would
      // make the one unrecoverable case the one this job is for.
      .execute()

    const expired = lapsed.filter((job) => {
      const at = job.lease_expires_at ? Date.parse(String(job.lease_expires_at)) : Number.NaN
      return !Number.isFinite(at) || at <= now.getTime()
    })

    if (expired.length === 0)
      return { ok: true, reclaimed: 0, cancelled: forced }

    const runs = new Set<number>()

    for (const job of expired) {
      const result: any = await db
        .updateTable('workflow_jobs')
        // The dead runner's credential goes with its lease. If it comes back
        // it authenticates as nothing, which is the honest answer - the work is
        // somebody else's now.
        .set({ state: 'queued', runner_id: null, lease_expires_at: null, job_token_hash: null } as any)
        .where('id', '=', Number(job.id))
        // Guarded on the state and the holder it was read at, so a runner that
        // heartbeated between the read and the write keeps its job. The sweep
        // must never take work from a machine that is alive.
        .where('state', '=', 'running')
        .where('runner_id', '=', String(job.runner_id))
        .execute()

      if (changed(result))
        runs.add(Number(job.workflow_run_id))
    }

    // A run whose only job went back to the queue is queued again rather than
    // running, and the screen should say so.
    for (const runId of runs)
      await settle(runId)

    return { ok: true, reclaimed: runs.size > 0 ? expired.length : 0, cancelled: forced }
  },
})

/**
 * End the jobs nobody acknowledged stopping.
 *
 * The forceful half of a cooperative cancellation. `CancelWorkflowRun` revokes
 * every lease at the moment of the request and leaves the running jobs in
 * `cancelling`, which is the honest state: asked to stop, not known to have.
 * Something has to close that, or the run sits there and the pull request waits
 * on it forever.
 *
 * **The clock is the revoked lease**, which cancelling set to the moment it was
 * requested. That saves a column whose only content would be the same instant,
 * and a column that can disagree with the lease is one that eventually does.
 *
 * A job that came back and said `cancelled` in the meantime is already terminal
 * and is not here; one that finished successfully between the request and now
 * is terminal too, and keeping that result is deliberate - the work really did
 * happen, and overwriting it would be the control plane inventing an outcome.
 */
async function forceStalledCancellations(now: Date): Promise<number> {
  const stalled: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id', 'lease_expires_at'])
    .where('state', '=', 'cancelling')
    .execute()

  const due = stalled.filter((job) => {
    const at = job.lease_expires_at ? Date.parse(String(job.lease_expires_at)) : Number.NaN

    // No lease recorded at all: nothing is going to acknowledge it, and waiting
    // on a clock that does not exist is waiting forever.
    if (!Number.isFinite(at))
      return true

    return now.getTime() - at >= CANCEL_GRACE_SECONDS * 1000
  })

  if (due.length === 0)
    return 0

  const runs = new Set<number>()
  let count = 0

  for (const job of due) {
    const result: any = await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now.toISOString(), job_token_hash: null } as any)
      .where('id', '=', Number(job.id))
      // Guarded on `cancelling`, so a runner that acknowledged - or finished -
      // between the read and the write keeps the outcome it reported.
      .where('state', '=', 'cancelling')
      .execute()

    if (changed(result)) {
      count += 1
      runs.add(Number(job.workflow_run_id))
    }
  }

  for (const runId of runs)
    await settle(runId)

  return count
}

/** This driver answers with a plain number; see `Runner/claim.ts`. */
function changed(result: any): boolean {
  if (typeof result === 'number')
    return result > 0

  if (typeof result === 'bigint')
    return result > 0n

  const first = Array.isArray(result) ? result[0] : result
  const affected = first?.numUpdatedRows ?? first?.numAffectedRows ?? first?.rowCount

  return affected === undefined || affected === null ? false : Number(affected) > 0
}

/** Recompute a run's state from its jobs, without moving it backwards. */
async function settle(runId: number): Promise<void> {
  const jobs: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['state'])
    .where('workflow_run_id', '=', runId)
    .execute()

  const next = runStateFromJobs(jobs.map(job => String(job.state) as JobState))

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['state'])
    .where('id', '=', runId)
    .executeTakeFirst()

  const from = String(run?.state ?? '')
  if (!from || from === next)
    return

  // Terminal runs are left alone. A finished run must not be reopened by a
  // late lease expiring underneath it.
  if (['succeeded', 'failed', 'cancelled'].includes(from))
    return

  await db
    .updateTable('workflow_runs')
    .set({ state: next } as any)
    .where('id', '=', runId)
    .where('state', '=', from)
    .execute()

  /*
   * The sweep is the one mover nobody is watching for.
   *
   * Every other transition happens because somebody asked - a claim, a report,
   * a cancellation - and whoever asked hears the answer. This one happens
   * because a machine stopped talking or a grace period ran out, so the event
   * is the *only* way anything downstream finds out.
   */
  const owning: any = await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()

  if (owning)
    await announceRunIfMoved(Number(owning.repository_id), runId, from, next)
}
