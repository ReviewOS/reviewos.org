import { db } from '@stacksjs/database'

/**
 * What a suite has been doing lately: the slowest tests, the least reliable
 * ones, and what is sitting in quarantine.
 *
 * The roadmap's phrasing for this was "surfaced without a query", and that is
 * the whole requirement. Every one of these numbers is derivable from
 * `test_executions` by anybody willing to write SQL, which means in practice
 * nobody looks at them - the slow test that got slower over four months is
 * invisible until somebody wonders why CI takes eleven minutes.
 *
 * Two rules the numbers follow, because a trend page that overstates its
 * evidence is worse than none:
 *
 * 1. **A ranking needs enough samples to mean anything.** One failure out of
 *    one run is not "0% reliable"; it is a test that ran once. Anything under
 *    `MIN_SAMPLES` is carried in `thin` rather than ranked.
 * 2. **Muted and skipped tests are labelled, never silently dropped.** A
 *    quarantined test disappearing from the least-reliable list is how a
 *    quarantine becomes permanent - the list stops mentioning the problem, so
 *    the problem stops existing.
 */

/** How far back a trend reads, in days. */
export const TREND_DAYS = 30

/** Below this many executions, a rate is noise rather than a measurement. */
export const MIN_SAMPLES = 5

export interface TrendTest {
  id: number
  suite: string
  scope: string
  name: string
  state: string
  owner: string | null
  flaky: boolean
  samples: number
  failures: number
  /** Passing share over the window, 0 to 1. Null when there are too few samples. */
  reliability: number | null
  /** Mean duration in milliseconds over the window. */
  averageMs: number
  /** Total time this test cost over the window - what actually shows up in the bill. */
  totalMs: number
}

export interface TrendSuite {
  suite: string
  runs: number
  tests: number
  failures: number
  reliability: number | null
  totalMs: number
}

export interface TestTrends {
  days: number
  branch: string | null
  suites: TrendSuite[]
  slowest: TrendTest[]
  leastReliable: TrendTest[]
  /** Ranked out for want of evidence, counted so the page can say so. */
  thin: number
  quarantined: TrendTest[]
  /** Quarantined past their review date. The number that keeps quarantine honest. */
  overdue: number
}

export async function testTrends(input: {
  repositoryId: number
  branch?: string | null
  days?: number
  limit?: number
}): Promise<TestTrends> {
  const days = Math.max(1, Math.min(365, Number(input.days) || TREND_DAYS))
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 10))
  const branch = String(input.branch ?? '').trim() || null
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const empty: TestTrends = {
    days,
    branch,
    suites: [],
    slowest: [],
    leastReliable: [],
    thin: 0,
    quarantined: [],
    overdue: 0,
  }

  if (!input.repositoryId)
    return empty

  let query = db
    .selectFrom('test_executions')
    .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
    .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'managed_tests.id as id',
      'managed_tests.name as name',
      'managed_tests.scope as scope',
      'managed_tests.state as state',
      'managed_tests.owner as owner',
      'managed_tests.flaky as flaky',
      'test_suites.slug as suite',
      'test_executions.result as result',
      'test_executions.duration_ms as duration_ms',
      'test_runs.id as run_id',
    ])
    .where('test_suites.repository_id', '=', input.repositoryId)
    .where('test_runs.created_at', '>=', since)

  if (branch)
    query = query.where('test_runs.branch', '=', branch)

  /*
   * Aggregated here rather than in three grouped queries.
   *
   * One pass over the window's executions answers every question on the page,
   * and the alternative - a query for the slowest, another for the least
   * reliable, another for the totals - is three scans that can disagree with
   * each other if a run lands between them.
   */
  const rows: any[] = await query.limit(200_000).execute().catch(() => [])

  if (!rows.length)
    return empty

  const tests = new Map<number, TrendTest>()
  const suites = new Map<string, TrendSuite & { runIds: Set<number> }>()

  for (const row of rows) {
    const id = Number(row.id)
    const suite = String(row.suite)
    const result = String(row.result)
    const durationMs = Number(row.duration_ms ?? 0) || 0

    const test = tests.get(id) ?? {
      id,
      suite,
      scope: String(row.scope ?? ''),
      name: String(row.name),
      state: String(row.state ?? 'enabled'),
      owner: row.owner ? String(row.owner) : null,
      flaky: row.flaky === true,
      samples: 0,
      failures: 0,
      reliability: null,
      averageMs: 0,
      totalMs: 0,
    }

    /*
     * A skipped execution is not a sample.
     *
     * It did not run, so counting it as a pass would make a suite look more
     * reliable the more of it somebody switched off - which is exactly the
     * wrong incentive for a page about reliability.
     */
    if (result !== 'skipped') {
      test.samples += 1
      test.totalMs += durationMs

      if (result === 'failed')
        test.failures += 1
    }

    tests.set(id, test)

    const bucket = suites.get(suite) ?? { suite, runs: 0, tests: 0, failures: 0, reliability: null, totalMs: 0, runIds: new Set<number>() }

    bucket.runIds.add(Number(row.run_id))
    bucket.totalMs += durationMs

    if (result === 'failed')
      bucket.failures += 1

    suites.set(suite, bucket)
  }

  for (const test of tests.values()) {
    test.averageMs = test.samples ? Math.round(test.totalMs / test.samples) : 0
    test.reliability = test.samples >= MIN_SAMPLES ? (test.samples - test.failures) / test.samples : null
  }

  const all = [...tests.values()]

  const bySuite = new Map<string, number>()

  for (const test of all)
    bySuite.set(test.suite, (bySuite.get(test.suite) ?? 0) + 1)

  const suiteRows: TrendSuite[] = [...suites.values()].map((bucket) => {
    const samples = all.filter(test => test.suite === bucket.suite).reduce((total, test) => total + test.samples, 0)

    return {
      suite: bucket.suite,
      runs: bucket.runIds.size,
      tests: bySuite.get(bucket.suite) ?? 0,
      failures: bucket.failures,
      reliability: samples >= MIN_SAMPLES ? (samples - bucket.failures) / samples : null,
      totalMs: bucket.totalMs,
    }
  }).sort((left, right) => right.totalMs - left.totalMs)

  const ranked = all.filter(test => test.reliability !== null)

  return {
    days,
    branch,
    suites: suiteRows,
    // Slowest by *total* time, not by mean: a 40ms test that runs in every one
    // of two thousand executions costs more than the one 9-second test, and it
    // is the total that shows up in how long CI takes.
    slowest: [...all].sort((left, right) => right.totalMs - left.totalMs).slice(0, limit),
    leastReliable: ranked
      .filter(test => (test.reliability ?? 1) < 1 || test.flaky)
      .sort((left, right) => (left.reliability ?? 1) - (right.reliability ?? 1) || right.failures - left.failures)
      .slice(0, limit),
    // Counted rather than hidden: "ranked from 12 of 400 tests" is the
    // difference between a measurement and a decoration.
    thin: all.length - ranked.length,
    quarantined: all.filter(test => test.state !== 'enabled'),
    overdue: await overdueCount(input.repositoryId),
  }
}

/** Quarantined tests whose review date has passed. */
async function overdueCount(repositoryId: number): Promise<number> {
  const rows = await db
    .selectFrom('managed_tests')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select(['managed_tests.review_at as review_at'])
    .where('test_suites.repository_id', '=', repositoryId)
    .where('managed_tests.state', '!=', 'enabled')
    .execute()
    .catch(() => [])

  const now = new Date().toISOString()

  return rows.filter(row => row.review_at && String(row.review_at) < now).length
}
