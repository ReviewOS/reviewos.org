/**
 * A run holding still for a clock, or for something outside it.
 *
 * The primitive under approvals, webhooks and every other human-in-the-loop
 * gate. `block:` already waits for **a person with an account here**; this
 * waits for whatever the world sends - a deployment that finished somewhere
 * else, a soak that has to last twenty minutes, a customer who clicked a link.
 *
 * ## A held job holds nothing
 *
 * It never reaches a runner. An `await` job is the control plane's own work,
 * like a barrier and a gate, so a workflow waiting three days costs three days
 * of a row rather than three days of a machine. That is also the thing that
 * makes it need a sweep: a run that holds nothing is a run nothing is looking
 * at, so something has to come back and ask whether its time is up.
 *
 * ## Why the deadline is a column
 *
 * The sweep runs every minute and asks exactly one question - which rows are
 * due - and that question against a JSON settings blob is a scan of every job
 * this instance has ever run. `wake_at` is that question's index.
 *
 * It is written once, when the wait begins, rather than derived from a duration
 * wherever somebody needs it. A wait that starts now and lasts thirty minutes
 * has exactly one end, and two places computing it from "when did this start"
 * eventually disagree about when it started.
 */

import { db } from '@stacksjs/database'
import { rowsChanged } from '../Support/sql'
import { settleRun } from './settle'

/** What a wait is waiting for, out of the settings the run copied. */
export interface WaitSettings {
  /** The event that ends it, when it waits to be told. */
  event: string
  /** How long it sleeps, when it ends by itself. */
  sleepSeconds: number | null
  /** The instant it sleeps until, when the file named one. */
  until: string | null
  /** How long an event has to arrive, when the file bounded it. */
  timeoutSeconds: number | null
  /** What an event that never arrives means. */
  onTimeout: 'fail' | 'continue'
}

/** A wait's settings, read out of a job row's copied JSON. */
export function waitSettingsOf(settings: unknown): WaitSettings {
  let body: Record<string, unknown> = {}

  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings

    if (parsed && typeof parsed === 'object')
      body = parsed as Record<string, unknown>
  }
  catch {
    body = {}
  }

  const sleep = Number(body.sleepSeconds)
  const timeout = Number(body.timeoutSeconds)

  return {
    event: typeof body.event === 'string' ? body.event.trim() : '',
    sleepSeconds: Number.isFinite(sleep) && sleep >= 0 ? Math.round(sleep) : null,
    until: typeof body.until === 'string' && body.until.trim() ? body.until.trim() : null,
    timeoutSeconds: Number.isFinite(timeout) && timeout >= 0 ? Math.round(timeout) : null,
    onTimeout: String(body.onTimeout ?? 'fail') === 'continue' ? 'continue' : 'fail',
  }
}

/**
 * When to look at this job again, and what to say about it meanwhile.
 *
 * The reason is on the row because "paused" on its own is the least useful word
 * a run screen can show: a job waiting twenty minutes and a job waiting for a
 * deployment nobody has triggered look identical, and only one of them is a
 * problem.
 */
export function waitPlan(settings: unknown, now: Date): { wakeAt: string | null, reason: string } {
  const wait = waitSettingsOf(settings)

  if (wait.event) {
    const deadline = wait.timeoutSeconds === null
      ? null
      : new Date(now.getTime() + wait.timeoutSeconds * 1000).toISOString()

    return {
      wakeAt: deadline,
      reason: deadline
        ? `Waiting for the \`${wait.event}\` event, until ${deadline}.`
        : `Waiting for the \`${wait.event}\` event.`,
    }
  }

  /*
   * `until:` wins over `sleep:` when a file somehow carries both, because it is
   * the more specific statement: a named instant is a fact about the world, and
   * a duration is a fact about this run.
   */
  const wakeAt = wait.until && !Number.isNaN(Date.parse(wait.until))
    ? new Date(Date.parse(wait.until)).toISOString()
    : new Date(now.getTime() + (wait.sleepSeconds ?? 60) * 1000).toISOString()

  return { wakeAt, reason: `Waiting until ${wakeAt}.` }
}

export interface WaitOutcome {
  /** How many sleeps ended. */
  slept: number
  /** How many waits for an event ran out of time. */
  timedOut: number
}

/**
 * End the waits whose time has come.
 *
 * A sleep that ends is a job that succeeded: it did what it was asked, which
 * was to wait. A wait for an event that ran out is a job that **failed**, and
 * that is the default rather than the choice - a run that goes green on "nobody
 * replied" is a green check for a deployment nobody approved. `on-timeout:
 * continue` is for the wait whose whole point is "give it a minute, then carry
 * on".
 *
 * The run is settled after each one rather than at the end, because settling is
 * what moves the graph and a batch that settled once would leave every run but
 * the last holding jobs that are ready to go.
 */
export async function endDueWaits(now: Date = new Date()): Promise<WaitOutcome> {
  const due = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id', 'settings', 'wake_at'])
    .where('state', '=', 'paused')
    .where('kind', '=', 'await')
    .where('wake_at', '<=', now.toISOString())
    .orderBy('wake_at')
    .limit(500)
    .execute()
    .catch(() => [])

  const outcome: WaitOutcome = { slept: 0, timedOut: 0 }

  for (const job of due) {
    const wait = waitSettingsOf(job.settings)
    const failed = Boolean(wait.event) && wait.onTimeout === 'fail'

    /*
     * Guarded on the state it was read at. Two sweeps overlapping, or a sweep
     * racing the event that was on its way, must not both end one wait - and
     * the row is the only thing that can arbitrate, because neither of them can
     * see the other.
     */
    const changed = await db
      .updateTable('workflow_jobs')
      .set({
        state: failed ? 'failed' : 'succeeded',
        finished_at: now.toISOString(),
        wake_at: null,
        condition_reason: wait.event
          ? `Nothing sent the \`${wait.event}\` event in time.`
          : 'The wait ended.',
      })
      .where('id', '=', Number(job.id))
      .where('state', '=', 'paused')
      .execute()
      .catch(() => null)

    if (!rowsChanged(changed))
      continue

    if (wait.event)
      outcome.timedOut += 1
    else
      outcome.slept += 1

    await settleRun(Number(job.workflow_run_id), now).catch(() => null)
  }

  return outcome
}

export interface DeliveredEvent {
  ok: boolean
  /** Whether this exact delivery had already been recorded. */
  duplicate: boolean
  /** How many waiting jobs it ended. */
  delivered: number
  error?: string
  status?: number
}

/**
 * Tell a run something, once.
 *
 * The insert is the linearization point: whoever wins the unique key delivered
 * the event, and a second sender with the same key is told it was already
 * recorded rather than waking a run twice on one thing that happened once. That
 * is not a nicety - a sender that does not hear an answer sends again, which is
 * what every webhook in the world does.
 *
 * **Recorded even when nothing is waiting.** An event that arrives a second
 * before its job becomes eligible would otherwise vanish and the run would sit
 * until its timeout on a message that did arrive. The row is here, so a wait
 * that starts later can find it.
 */
export async function sendRunEvent(input: {
  runId: number
  repositoryId: number | null
  name: string
  payload: Record<string, unknown> | null
  key?: string | null
  actorId?: number | null
  source?: string
  now?: Date
}): Promise<DeliveredEvent> {
  const now = input.now ?? new Date()
  const name = String(input.name ?? '').trim()

  if (!name)
    return { ok: false, duplicate: false, delivered: 0, error: 'An event needs a name', status: 422 }

  const body = input.payload && typeof input.payload === 'object'
    ? JSON.stringify(input.payload).slice(0, 20_000)
    : null

  /*
   * A key derived from the delivery when the sender named none.
   *
   * A unique index over a nullable column enforces nothing for exactly the
   * callers least likely to be careful, so there is always a key - it is just
   * that an unnamed one only collides with a byte-identical resend in the same
   * second, which is the honest guess at what the sender meant.
   */
  const key = String(input.key ?? '').trim()
    || `${input.runId}:${name}:${Math.floor(now.getTime() / 1000)}:${(body ?? '').length}`

  const existing = await db
    .selectFrom('workflow_run_events')
    .select(['id', 'delivered_to'])
    .where('idempotency_key', '=', key)
    .executeTakeFirst()
    .catch(() => null)

  if (existing?.id)
    return { ok: true, duplicate: true, delivered: Number(existing.delivered_to ?? 0) }

  const inserted: any = await db
    .insertInto('workflow_run_events')
    .values({
      workflow_run_id: input.runId,
      repository_id: input.repositoryId ?? null,
      name,
      payload: body,
      idempotency_key: key,
      actor_id: input.actorId ?? null,
      source: input.source ?? 'api',
      delivered_to: 0,
    })
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => null)

  if (!inserted?.id) {
    /*
     * The insert lost the race for the key, which is the case it is here to
     * lose. Somebody else delivered this exact event a moment ago, and the
     * honest answer is the one they got.
     */
    const winner = await db
      .selectFrom('workflow_run_events')
      .select(['delivered_to'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst()
      .catch(() => null)

    return winner
      ? { ok: true, duplicate: true, delivered: Number(winner.delivered_to ?? 0) }
      : { ok: false, duplicate: false, delivered: 0, error: 'The event could not be recorded', status: 500 }
  }

  const delivered = await wakeWaitersFor(input.runId, name, body, now)

  await db
    .updateTable('workflow_run_events')
    .set({ delivered_to: delivered })
    .where('id', '=', Number(inserted.id))
    .execute()
    .catch(() => null)

  if (delivered > 0)
    await settleRun(input.runId, now).catch(() => null)

  return { ok: true, duplicate: false, delivered }
}

/**
 * End the waits in one run that were waiting for this event.
 *
 * Every one of them, rather than the first: two jobs waiting for the same
 * event is a run that fans out on one signal, and waking one of them would be a
 * graph whose shape depends on row order.
 *
 * The payload becomes each job's outputs, so a later job reads it as
 * `needs.approval.outputs.version` - the same way it reads any other job's.
 */
async function wakeWaitersFor(runId: number, name: string, payload: string | null, now: Date): Promise<number> {
  const waiting = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'settings'])
    .where('workflow_run_id', '=', runId)
    .where('state', '=', 'paused')
    .where('kind', '=', 'await')
    .execute()
    .catch(() => [])

  let woken = 0

  for (const job of waiting) {
    if (waitSettingsOf(job.settings).event !== name)
      continue

    const changed = await db
      .updateTable('workflow_jobs')
      .set({
        state: 'succeeded',
        finished_at: now.toISOString(),
        wake_at: null,
        outputs: payload,
        condition_reason: `The \`${name}\` event arrived.`,
      })
      .where('id', '=', Number(job.id))
      // Guarded on the state it was read at: the timeout sweep may be ending
      // this same wait right now, and only one of the two may decide.
      .where('state', '=', 'paused')
      .execute()
      .catch(() => null)

    if (rowsChanged(changed))
      woken += 1
  }

  return woken
}

/**
 * An event this run was already told, for a wait that has only just begun.
 *
 * The lost wakeup, closed from the other side: an event that arrived before its
 * job became eligible is a row nobody has read, and a wait that did not look
 * would sit until its timeout on a message that did arrive.
 */
export async function alreadySent(runId: number, name: string): Promise<{ payload: string | null } | null> {
  if (!name)
    return null

  const row = await db
    .selectFrom('workflow_run_events')
    .select(['payload'])
    .where('workflow_run_id', '=', runId)
    .where('name', '=', name)
    .orderBy('id', 'desc')
    .executeTakeFirst()
    .catch(() => null)

  return row ? { payload: row.payload === null || row.payload === undefined ? null : String(row.payload) } : null
}
