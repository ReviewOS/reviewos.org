import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { rowsChanged as changed } from '../Actions/Support/sql'
import { settleRun } from '../Actions/Workflow/settle'
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

    // And before the reclaim, because a job that ran out of time is not one to
    // give back to the queue: requeuing it would start the same overrun again
    // on a different machine.
    const timedOut = await stopOverrunJobs(now)

    const lapsed = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id', 'runner_id', 'lease_expires_at', 'attempt'])
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
      return { ok: true, reclaimed: 0, cancelled: forced, timedOut }

    const runs = new Set<number>()

    for (const job of expired) {
      const attempt = Number(job.attempt ?? 1)

      /*
       * A job whose runner keeps dying is failed rather than requeued forever.
       *
       * This loop had no counter at all: every lapsed lease put the job back
       * in the queue, so a job that kills the machine it runs on - out of
       * memory, out of disk, a kernel it does not like - was handed to every
       * runner in the fleet in turn, for as long as the fleet existed. The
       * attempt column bounds it, and the failure says what happened rather
       * than reading as an ordinary one.
       */
      if (attempt >= MAX_LOST_ATTEMPTS) {
        const ended = await db
          .updateTable('workflow_jobs')
          .set({
            state: 'failed',
            finished_at: now.toISOString(),
            runner_id: null,
            lease_expires_at: null,
            job_token_hash: null,
            condition_reason: `Handed to ${attempt} runners and each stopped responding. This job is failing its machine rather than failing on it.`,
          })
          .where('id', '=', Number(job.id))
          .where('state', '=', 'running')
          .where('runner_id', '=', String(job.runner_id))
          .execute()

        if (changed(ended))
          runs.add(Number(job.workflow_run_id))

        continue
      }

      const result = await db
        .updateTable('workflow_jobs')
        // The dead runner's credential goes with its lease. If it comes back
        // it authenticates as nothing, which is the honest answer - the work is
        // somebody else's now.
        .set({
          state: 'queued',
          runner_id: null,
          lease_expires_at: null,
          job_token_hash: null,
          attempt: attempt + 1,
          // Reclaimed work waits for a machine from now, not from whenever the
          // lost runner first took it.
          queued_at: new Date().toISOString(),
        })
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

    return { ok: true, reclaimed: runs.size > 0 ? expired.length : 0, cancelled: forced, timedOut }
  },
})

/**
 * The instance ceiling on how long a job may run.
 *
 * Actions' six hours, used when a workflow does not say. It is not an opinion
 * about how long a job should take - it exists so that nothing runs *forever*,
 * which is the failure a lease alone cannot catch: a runner that is alive and
 * heartbeating about a step that hangs will hold its job until somebody
 * notices, and nobody notices until the pull request is a day old.
 */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 360

/**
 * How many machines may lose a job before the job is the suspect.
 *
 * Requeuing a job whose runner died is at-least-once recovery and it is right;
 * doing it without a limit is how one job takes down a fleet one machine at a
 * time. Three: enough that two unlucky machines do not fail somebody's build,
 * few enough that a job which kills whatever runs it stops being handed out.
 */
export const MAX_LOST_ATTEMPTS = 3

/**
 * Stop the jobs that ran past their `timeout-minutes`.
 *
 * The control plane's half of a timeout the runner also enforces. Both halves
 * are needed and they fail differently: the runner knows *which step* the time
 * went into and can say so, and this one is what happens when the runner is the
 * thing that is stuck.
 *
 * `cancelling` rather than `failed`, for the same reason cancellation is
 * cooperative everywhere else - the work is on a machine this instance does not
 * control, and a job declared over while it is still running is a screen
 * telling somebody something untrue. The lease is revoked in the same write, so
 * the runner cannot report over the decision, and the grace path above turns it
 * into `cancelled` when nobody acknowledges.
 */
async function stopOverrunJobs(now: Date): Promise<number> {
  const running = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id', 'started_at', 'timeout_minutes'])
    .where('state', '=', 'running')
    .execute()

  const overrun = running.filter((job) => {
    const started = job.started_at ? Date.parse(String(job.started_at)) : Number.NaN

    /*
     * A running job with no start time is left alone rather than stopped.
     *
     * There is no clock to judge it by, and guessing "it must have been a
     * while" would end somebody's build on no evidence. The lease sweep below
     * still catches it if its runner has gone.
     */
    if (!Number.isFinite(started))
      return false

    const minutes = Number(job.timeout_minutes ?? DEFAULT_JOB_TIMEOUT_MINUTES)
    const allowed = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_JOB_TIMEOUT_MINUTES

    return now.getTime() - started >= allowed * 60_000
  })

  if (overrun.length === 0)
    return 0

  const runs = new Set<number>()
  let count = 0

  for (const job of overrun) {
    const result = await db
      .updateTable('workflow_jobs')
      .set({
        state: 'cancelling',
        lease_expires_at: now.toISOString(),
        condition_reason: `This job ran past its ${Number(job.timeout_minutes ?? DEFAULT_JOB_TIMEOUT_MINUTES)}-minute timeout.`,
      })
      .where('id', '=', Number(job.id))
      // Guarded on `running`, so a job that finished between the read and the
      // write keeps the result it reported.
      .where('state', '=', 'running')
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
  const stalled = await db
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
    const result = await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now.toISOString(), job_token_hash: null })
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

/**
 * Move the run on, and say so.
 *
 * The same settler a report uses, which is the point of it being shared: a job
 * this sweep cancelled unblocks and skips exactly what a job a runner reported
 * would, and until it did, a force-cancelled job left its dependants in
 * `blocked` and the run never finished at all.
 */
async function settle(runId: number): Promise<void> {
  const run = await db
    .selectFrom('workflow_runs')
    .select(['state', 'repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()

  if (!run)
    return

  const from = String(run.state ?? '')
  const next = await settleRun(runId)

  if (!from || from === next)
    return

  /*
   * The sweep is the one mover nobody is watching for.
   *
   * Every other transition happens because somebody asked - a claim, a report,
   * a cancellation - and whoever asked hears the answer. This one happens
   * because a machine stopped talking or a grace period ran out, so the event
   * is the *only* way anything downstream finds out.
   */
  await announceRunIfMoved(Number(run.repository_id), runId, from, next)
}
