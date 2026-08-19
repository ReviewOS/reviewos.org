/**
 * Stopping a run without throwing it away, and starting it again.
 *
 * The control between "let it finish" and "cancel it", and the one people
 * actually want at three in the afternoon: a dependency looks wrong, the fleet
 * is on fire, somebody wants to look at the workspace before the next job
 * touches it. Cancelling to buy five minutes means re-running everything that
 * had already passed.
 *
 * ## What a pause does and does not stop
 *
 * **Work already on a machine keeps going.** A runner mid-build is not
 * something this instance can politely interrupt - the cooperative half of
 * cancellation exists precisely because it cannot - and a screen claiming the
 * run has stopped while a machine is still billing for it would be a lie in the
 * expensive direction.
 *
 * What stops is everything that has not started. The claim only ever hands out
 * jobs from a run in `queued` or `running`, so a paused run is one no machine
 * is offered work from, and the rule lives in the one place that decides rather
 * than being spread across the graph.
 *
 * ## Why `paused_at` as well as the state
 *
 * Resuming has to put the run back to whatever it *would* have been, which is
 * computed from its jobs - and cannot be if the pause overwrote the only record
 * that there was a pause. The column is also what a screen reads to say who,
 * and when.
 */

import { db } from '@stacksjs/database'
import { rowsChanged } from '../Support/sql'
import { settleRun } from './settle'

/** Runs nobody may pause, because they have already stopped. */
const FINISHED = ['succeeded', 'failed', 'cancelled']

export interface PauseOutcome {
  ok: boolean
  /** The run's state after this. */
  state: string
  /** Whether this call is what changed it. */
  changed: boolean
  error?: string
  status?: number
}

/**
 * Hold a run.
 *
 * Pausing a run that is already paused is not an error and not a duplicate to
 * complain about: two people looking at the same red pipeline and both pressing
 * the button is an ordinary afternoon, and the second one has not made a
 * mistake. They are told it is held, which is what they wanted to be true.
 */
export async function pauseRun(input: { runId: number, actorId?: number | null, now?: Date }): Promise<PauseOutcome> {
  const now = input.now ?? new Date()

  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'paused_at'])
    .where('id', '=', input.runId)
    .executeTakeFirst()

  if (!run)
    return { ok: false, state: '', changed: false, error: 'No such run', status: 404 }

  const from = String(run.state ?? 'queued')

  if (FINISHED.includes(from)) {
    return {
      ok: false,
      state: from,
      changed: false,
      error: `This run has already ${from === 'succeeded' ? 'finished' : from}. There is nothing left to hold.`,
      status: 409,
    }
  }

  if (from === 'cancelling') {
    /*
     * A run on its way out is not one to hold. Its leases are revoked and its
     * jobs are being stopped; pausing it would leave a run that can neither
     * finish stopping nor start again, which is a state nothing knows how to
     * get out of.
     */
    return {
      ok: false,
      state: from,
      changed: false,
      error: 'This run is being cancelled. It cannot be held on its way out.',
      status: 409,
    }
  }

  if (run.paused_at)
    return { ok: true, state: 'paused', changed: false }

  const changed = await db
    .updateTable('workflow_runs')
    .set({ state: 'paused', paused_at: now.toISOString(), paused_by_id: input.actorId ?? null })
    .where('id', '=', input.runId)
    // Guarded on the state it was read at, so a run that finished in between is
    // not dragged back out of a conclusion by a button pressed a second late.
    .where('state', '=', from)
    .execute()
    .catch(() => null)

  return rowsChanged(changed)
    ? { ok: true, state: 'paused', changed: true }
    : { ok: false, state: from, changed: false, error: 'This run moved while it was being held. Look at it again.', status: 409 }
}

/**
 * Let it go again.
 *
 * The state is not restored from anything remembered - it is recomputed from
 * the jobs, which is the only record that cannot be stale. A run paused while
 * three jobs were running and resumed after they all finished is a run that
 * has finished, and a stored "it was running" would put it back to a state it
 * left while nobody was watching.
 */
export async function resumeRun(input: { runId: number, now?: Date }): Promise<PauseOutcome> {
  const now = input.now ?? new Date()

  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'paused_at'])
    .where('id', '=', input.runId)
    .executeTakeFirst()

  if (!run)
    return { ok: false, state: '', changed: false, error: 'No such run', status: 404 }

  if (!run.paused_at)
    return { ok: true, state: String(run.state ?? 'queued'), changed: false }

  await db
    .updateTable('workflow_runs')
    /*
     * Back to `queued` before settling, rather than to a guess.
     *
     * `queued` is the state that says "nothing has been decided about this
     * yet", which is exactly true for a heartbeat, and the settle that follows
     * replaces it with what the jobs actually say. Writing a guessed state and
     * settling afterwards would show a flicker somebody screenshots.
     */
    .set({ state: 'queued', paused_at: null, paused_by_id: null })
    .where('id', '=', input.runId)
    .where('state', '=', 'paused')
    .execute()
    .catch(() => null)

  const state = await settleRun(input.runId, now)

  return { ok: true, state: String(state ?? 'queued'), changed: true }
}
