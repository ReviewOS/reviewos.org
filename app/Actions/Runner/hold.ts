/**
 * A runner's capacity hold, as the instance remembers it.
 *
 * A runner that checks its own disk or load before claiming says "no work,
 * please" on every poll until it has room. From the instance that looked
 * exactly like a healthy idle machine - seen every few seconds, taking nothing
 * - and the reason lived only in the machine's own log. A job for it sat
 * queued from ten at night until somebody read that log in the morning.
 *
 * So the poll that holds now says why, and the instance keeps it on the
 * runner's row until the first poll that accepts work again. Both directions
 * are compatible: an older instance ignores the field, and an older runner that
 * holds without a reason is recorded as holding with the fallback below rather
 * than as idle.
 */

import { db } from '@stacksjs/database'

/** The longest reason kept. A sentence, not a log. */
export const HOLD_REASON_MAX = 1000

/** What an older runner that holds without saying why is recorded as. */
export const UNEXPLAINED_HOLD = 'The runner is refusing work and did not say why (runners before the hold-reason release do not report one)'

/**
 * What to store for one claim: the reason when it holds, null when it accepts.
 *
 * Control characters are folded to spaces: the reason is the runner's own
 * words, it is shown on pages and in API answers, and a newline or an escape
 * sequence in it is formatting nobody asked for.
 */
export function holdFromClaim(acceptWork: unknown, reason: unknown): string | null {
  if (acceptWork !== false)
    return null

  const text = typeof reason === 'string'
    // eslint-disable-next-line no-control-regex
    ? reason.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  return (text || UNEXPLAINED_HOLD).slice(0, HOLD_REASON_MAX)
}

export interface StoredHold {
  reason: string | null
  startedAt: string | null
}

/**
 * The columns to write, or null when the row already says the right thing.
 *
 * A held runner polls every few seconds, and writing the same sentence back on
 * every one of them is churn on the busiest row in the fleet. The start time is
 * kept across a change of reason: a machine that is still out of disk, now by
 * a different number of MiB, has been holding since the first poll, not since
 * the latest one.
 */
export function holdUpdate(stored: StoredHold, next: string | null, now: Date): { hold_reason: string | null, hold_started_at: string | null } | null {
  if (next === null)
    return stored.reason === null && stored.startedAt === null ? null : { hold_reason: null, hold_started_at: null }

  if (stored.reason === next && stored.startedAt)
    return null

  return { hold_reason: next, hold_started_at: stored.startedAt ?? now.toISOString() }
}

/**
 * Record what this claim said about capacity on the runner's row.
 *
 * Never throws. The hold is an explanation, and a failure to write an
 * explanation must not become a failed claim - least of all on an instance
 * whose migration for these columns has not run yet.
 */
export async function recordHold(runnerId: number, next: string | null, now: Date = new Date()): Promise<void> {
  try {
    const row: any = await db
      .selectFrom('runners')
      .select(['hold_reason', 'hold_started_at'])
      .where('id', '=', runnerId)
      .executeTakeFirst()

    if (!row)
      return

    const update = holdUpdate({
      reason: row.hold_reason ? String(row.hold_reason) : null,
      startedAt: row.hold_started_at ? String(row.hold_started_at) : null,
    }, next, now)

    if (!update)
      return

    await db.updateTable('runners').set(update).where('id', '=', runnerId).execute()
  }
  catch {
    // Deliberately quiet: see above.
  }
}
