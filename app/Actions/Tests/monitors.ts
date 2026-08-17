import { db } from '@stacksjs/database'
import { notifyProgramsOnly } from '../../Notifications/emit'

/**
 * Rules that watch a suite over time, and fire once when the answer changes.
 *
 * **A monitor is a state machine, not a query.** "Is the failure rate above
 * 5%?" is true every hour it is true, and a rule that acted on the answer would
 * send the same alarm twenty-four times a day - which is how a channel becomes
 * one people mute, and the muted channel is the one that has to work the day it
 * matters. So the monitor remembers where it was, and only the transition is an
 * event.
 *
 * The recovery is an event too, and that is not a courtesy: somebody told a
 * suite is unreliable has no way to learn it is fine again, and a dashboard
 * that only ever goes red is one people stop looking at.
 */

/** What each condition measures, so the answer can be said in words. */
export const CONDITIONS = {
  flaky: { unit: 'tests', describes: 'tests that disagree with themselves' },
  /*
   * A percentage, not a share from zero to one.
   *
   * Somebody typing `5` at a field that wants a share has written five hundred
   * percent, and the monitor they just made can never fire - which is worse
   * than no monitor, because it reads as covered. Percent is what they meant
   * and what every dashboard shows.
   */
  fail_rate: { unit: '%', describes: 'percentage of executions that failed' },
  duration: { unit: 'ms', describes: 'what one run of the suite costs' },
} as const

export type MonitorCondition = keyof typeof CONDITIONS

export interface MonitorRow {
  id: number
  repositoryId: number
  suite: string
  condition: MonitorCondition
  threshold: number
  windowDays: number
  state: 'ok' | 'alarm'
}

export type Transition = 'alarm' | 'recovered' | null

/**
 * Whether this evaluation changes anything.
 *
 * Split out and pure because it is the whole feature: everything else here is
 * reading numbers out of a table, and the one thing that must never be got
 * wrong is that a condition which was already true does not fire again.
 *
 * **A measurement it could not take is not a recovery.** A suite nobody
 * reported for this week has no failure rate, and reading that as "back to
 * normal" would clear an alarm because the reporting broke - which is the exact
 * moment somebody needs the alarm to still be there.
 */
export function decideTransition(input: {
  state: 'ok' | 'alarm'
  measurement: number | null
  threshold: number
}): Transition {
  if (input.measurement === null)
    return null

  const over = input.measurement > input.threshold

  if (over && input.state !== 'alarm')
    return 'alarm'

  if (!over && input.state === 'alarm')
    return 'recovered'

  return null
}

export interface Measurement {
  value: number | null
  /** How many executions the number came from, so thin evidence is visible. */
  samples: number
}

/** What a monitor's condition currently reads, over its own window. */
export async function measure(monitor: MonitorRow, now: Date = new Date()): Promise<Measurement> {
  const since = new Date(now.getTime() - Math.max(1, monitor.windowDays) * 86_400_000).toISOString()

  let query = db
    .selectFrom('test_executions')
    .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
    .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'test_executions.result as result',
      'test_executions.duration_ms as duration_ms',
      'managed_tests.id as test_id',
      'managed_tests.flaky as flaky',
      'managed_tests.state as test_state',
      'test_runs.id as run_id',
    ])
    .where('test_suites.repository_id', '=', monitor.repositoryId)
    .where('test_runs.created_at', '>=', since)

  if (monitor.suite)
    query = query.where('test_suites.slug', '=', monitor.suite)

  const rows: any[] = await query.limit(200_000).execute().catch(() => [])

  if (!rows.length)
    return { value: null, samples: 0 }

  if (monitor.condition === 'flaky') {
    const flaky = new Set<number>()

    for (const row of rows) {
      if (row.flaky === true)
        flaky.add(Number(row.test_id))
    }

    return { value: flaky.size, samples: rows.length }
  }

  if (monitor.condition === 'duration') {
    const runs = new Set<number>()
    let total = 0

    for (const row of rows) {
      runs.add(Number(row.run_id))
      total += Number(row.duration_ms ?? 0) || 0
    }

    // Per run, not the total over the window: the total grows with how often
    // CI ran, so a threshold set against it would alarm on a busy week.
    return { value: Math.round(total / Math.max(1, runs.size)), samples: rows.length }
  }

  /*
   * Failures over executions, with muted tests left out.
   *
   * A muted test's failures do not count against a run anywhere else, and a
   * monitor that counted them would alarm on exactly the tests somebody has
   * already decided about - the quarantine would stop being a decision and
   * become a source of noise.
   */
  const counted = rows.filter(row => String(row.result) !== 'skipped' && String(row.test_state) !== 'muted')

  if (!counted.length)
    return { value: null, samples: 0 }

  const failed = counted.filter(row => String(row.result) === 'failed').length

  // As a percentage, matching the unit the threshold is written in. The two
  // being in different units is the bug this whole page would be about.
  return { value: (failed / counted.length) * 100, samples: counted.length }
}

export interface EvaluationOutcome {
  evaluated: number
  transitions: Array<{ id: number, to: Transition, measurement: number }>
}

/**
 * Evaluate every enabled monitor, write what changed, and announce it.
 *
 * The announcement is `test:monitor`, webhook-only. Nobody wants an inbox entry
 * every time a suite wobbles, and this is a rule somebody wrote for a program
 * to act on - the same reasoning `check:reported` is webhook-only for.
 */
export async function evaluateMonitors(repositoryId?: number, now: Date = new Date()): Promise<EvaluationOutcome> {
  let query = db
    .selectFrom('test_monitors')
    .select(['id', 'repository_id', 'suite', 'condition', 'threshold', 'window_days', 'state'])
    .where('enabled', '=', true)

  if (repositoryId)
    query = query.where('repository_id', '=', repositoryId)

  const monitors: any[] = await query.limit(1000).execute().catch(() => [])
  const outcome: EvaluationOutcome = { evaluated: 0, transitions: [] }

  for (const row of monitors) {
    const monitor: MonitorRow = {
      id: Number(row.id),
      repositoryId: Number(row.repository_id),
      suite: String(row.suite ?? ''),
      condition: String(row.condition) as MonitorCondition,
      threshold: Number(row.threshold ?? 0),
      windowDays: Number(row.window_days ?? 7),
      state: String(row.state) === 'alarm' ? 'alarm' : 'ok',
    }

    const reading = await measure(monitor, now)
    const transition = decideTransition({ state: monitor.state, measurement: reading.value, threshold: monitor.threshold })

    outcome.evaluated += 1

    /*
     * `evaluated_at` moves even when nothing changed, and `changed_at` does
     * not. The difference is how somebody tells "this rule says everything is
     * fine" from "this rule has not run since March".
     */
    await db
      .updateTable('test_monitors')
      .set({
        evaluated_at: now.toISOString(),
        measurement: reading.value ?? 0,
        ...(transition ? { state: transition === 'alarm' ? 'alarm' : 'ok', changed_at: now.toISOString() } : {}),
      } as any)
      .where('id', '=', monitor.id)
      .execute()
      .catch(() => null)

    if (!transition)
      continue

    outcome.transitions.push({ id: monitor.id, to: transition, measurement: reading.value ?? 0 })

    await announce(monitor, transition, reading).catch(() => null)
  }

  return outcome
}

/** One transition, to programs. Never throws: an alarm is not worth failing a sweep over. */
async function announce(monitor: MonitorRow, transition: Transition, reading: Measurement): Promise<void> {
  try {
    const repository: any = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id'])
      .where('id', '=', monitor.repositoryId)
      .executeTakeFirst()

    if (!repository)
      return

    const owner: any = String(repository.owner_type) === 'user'
      ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
      : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()

    await notifyProgramsOnly('test:monitor', {
      // Nothing was clicked; a rule fired. Zero reads as "the system"
      // everywhere else this happens.
      actorId: 0,
      actorHandle: '',
      repositoryId: monitor.repositoryId,
      owner: String(owner?.handle ?? ''),
      repository: String(repository.name ?? ''),
      subjectType: 'repository',
      subjectId: monitor.repositoryId,
      title: transition === 'alarm'
        ? `${monitor.suite || 'tests'}: ${CONDITIONS[monitor.condition].describes} passed ${monitor.threshold}`
        : `${monitor.suite || 'tests'}: back under ${monitor.threshold}`,
      monitor: {
        id: monitor.id,
        suite: monitor.suite || null,
        condition: monitor.condition,
        threshold: monitor.threshold,
        window_days: monitor.windowDays,
        // `action` carries the transition, so one subscription covers both
        // directions - the shape every other event here uses.
        action: transition,
        measurement: reading.value,
        samples: reading.samples,
      },
    } as any)
  }
  catch (error) {
    console.error('[tests] could not announce a monitor transition:', error)
  }
}
