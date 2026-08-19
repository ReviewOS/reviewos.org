/**
 * How many mirrors have quietly stopped, and what that says about the instance.
 *
 * A mirror that is late *and* has never errored is not a mirror problem. Every
 * way a sync can go wrong writes `last_error` and increments `failure_count` -
 * see `app/Jobs/MirrorSyncJob.ts`, which records the failure before it rethrows
 * - so a row that is far past its interval with a clean record is a row nothing
 * ever came for. Something upstream of the mirror is not running.
 *
 * That is the shape of the worst deployment bug this instance has had: nothing
 * in any documented deployment ran `buddy schedule:run`, so the sweep that
 * enqueues these never fired, on any instance, ever. Health was green
 * throughout - the queue was empty because nothing was filling it - and the
 * only visible symptom was a repository page saying "synced 1 day ago".
 *
 * Pure and separate from the health check so the rule can be tested against
 * rows rather than against a stopped scheduler.
 */

import type { MirrorTimingRow } from './status'
import { mirrorHealth } from './status'

/**
 * Mirrors that are overdue with nothing to blame it on.
 *
 * `stale` and not `failing`: a mirror erroring every fifteen minutes is being
 * swept perfectly well and has a different problem, and counting it here would
 * point an operator at the clock when the answer is a revoked token.
 *
 * A mirror that has *never* synced is not counted either. That is the ordinary
 * state of one created a minute ago, and the first sweep has not necessarily
 * come round yet - it says "not synced yet" on the page, which is honest, and
 * it becomes stale here like any other once its interval has passed.
 */
export function staleMirrors(rows: readonly MirrorTimingRow[], now: Date = new Date()): number {
  return rows.filter(row => mirrorHealth(row, now) === 'stale').length
}
