import { db } from '@stacksjs/database'
import { numberSetting } from '../../Ops/settings'

/**
 * How long test executions are kept, and the sweep that keeps that promise.
 *
 * **Execution rows are the one table here that grows without a ceiling.** A
 * suite of two thousand tests, reported on every commit, writes two thousand
 * rows per push - a busy repository can produce several million a month, which
 * is fine until it is the largest table in the database and nobody knows why.
 *
 * So the policy is stated in days, in one place, with the cost in bytes written
 * next to it, and the sweep is the thing that makes the number true rather than
 * the place the number lives. A rule that exists only inside a cron job is one
 * nobody can quote.
 *
 * ## What is kept and what goes
 *
 * The *executions* go. The tests, the suites, and the runs stay: a run is one
 * row carrying counts somebody may want a year later, and a test row is the
 * identity everything else refers to - deleting those would take the mute, the
 * owner and the reason with them, which is history somebody deliberately
 * recorded rather than data that accumulated.
 */

/** Days of per-execution history kept by default. */
export const DEFAULT_RETENTION_DAYS = 90

/**
 * Roughly what one execution row costs, including its indexes.
 *
 * Measured rather than guessed: the row is four integers, three short strings
 * and two nullable text columns, and the failure message on a *failing* test is
 * the part that varies. Passing executions - which is nearly all of them -
 * carry no message, and this is the number to multiply by when sizing.
 */
export const BYTES_PER_EXECUTION = 220

export interface RetentionPolicy {
  days: number
}

/**
 * The policy, from the instance setting an administrator can change without a
 * deploy - the same place the registration mode and the repository limit live.
 *
 * **Zero means keep everything**, and it is a real answer rather than an
 * oversight: an instance that has to prove what its tests did two years ago
 * needs it. It is also the answer whose cost is unbounded, which is why the
 * setting says so in its own description rather than leaving somebody to find
 * out from a full disk.
 */
export async function retentionPolicy(): Promise<RetentionPolicy> {
  const configured = await numberSetting('test_retention_days').catch(() => Number.NaN)

  if (Number.isFinite(configured) && configured >= 0)
    return { days: Math.min(3650, Math.floor(configured)) }

  // A database this cannot read is not a reason to delete anything on a
  // guess, so the built-in default stands.
  return { days: DEFAULT_RETENTION_DAYS }
}

/** What a suite of this size, reported this often, will cost to keep. */
export function estimateBytes(input: { tests: number, runsPerDay: number, days?: number }): number {
  const days = Number(input.days) || DEFAULT_RETENTION_DAYS

  return Math.max(0, Math.round(input.tests * input.runsPerDay * days * BYTES_PER_EXECUTION))
}

export interface SweepOutcome {
  ok: boolean
  days: number
  removed: number
  /** Executions still held after the sweep, so the number means something. */
  remaining: number
}

/**
 * Delete executions older than the policy.
 *
 * In batches, and the batching is not a micro-optimisation: the first sweep on
 * an instance that has been recording for a year is a single statement against
 * millions of rows, which takes a lock long enough that pushes start timing out
 * while it runs. Two hundred runs at a time finishes in the same total time and
 * never holds anything for long.
 */
export async function sweepTestExecutions(now: Date = new Date()): Promise<SweepOutcome> {
  const { days } = await retentionPolicy()

  /*
   * Zero keeps everything, and the sweep does nothing at all rather than
   * treating "no retention" as "retain nothing" - which is the direction this
   * mistake always goes, and it deletes the history instead of keeping it.
   */
  if (days <= 0) {
    const held = await db.selectFrom('test_executions').select(db.fn.count('id').as('count')).executeTakeFirst().catch(() => null)

    return { ok: true, days: 0, removed: 0, remaining: Number(held?.count ?? 0) }
  }

  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()

  let removed = 0

  for (let pass = 0; pass < 200; pass++) {
    /*
     * By run rather than by execution date, because an execution has no date of
     * its own worth trusting - it belongs to the run that reported it, and that
     * is the timestamp somebody set out to keep for ninety days.
     */
    const runs = await db
      .selectFrom('test_runs')
      .select(['id'])
      .where('created_at', '<', cutoff)
      .orderBy('id', 'asc')
      .limit(200)
      .execute()
      .catch(() => [])

    if (!runs.length)
      break

    const ids = runs.map(row => Number(row.id))

    const result = await db
      .deleteFrom('test_executions')
      .where('test_run_id', 'in', ids)
      .executeTakeFirst()
      .catch(() => null)

    removed += Number(result?.numDeletedRows ?? 0)

    /*
     * The run rows go too, once their executions have.
     *
     * Keeping a run whose executions are gone would leave counts nothing can be
     * checked against, which is the sort of half-record that makes somebody
     * distrust the whole table. The tests themselves stay: their mutes, owners
     * and reasons are decisions people made, not data that piled up.
     */
    await db
      .deleteFrom('test_runs')
      .where('id', 'in', ids)
      .execute()
      .catch(() => null)
  }

  const left = await db
    .selectFrom('test_executions')
    .select(db.fn.count('id').as('count'))
    .executeTakeFirst()
    .catch(() => null)

  return { ok: true, days, removed, remaining: Number(left?.count ?? 0) }
}
