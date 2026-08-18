import { db } from '@stacksjs/database'

/**
 * What the tests say about a pull request, and - the part nobody else does -
 * whether this branch is what made them unreliable.
 *
 * "There are seven flaky tests" is a sentence a reviewer learns to skip.
 * "Six of these were already flaky on main; this branch made the seventh one
 * flaky" is a sentence they act on. Every other forge shows the first, because
 * flakiness is stored as a property of the test rather than measured per branch
 * - and a test that has been flaky on main for a month then decorates every
 * pull request that touches nothing near it.
 *
 * So flakiness here is computed twice, from the same rule, over two different
 * slices of history: the head branch and the base. The difference is the
 * finding.
 */

/** How far back a branch's history is read when deciding it disagrees with itself. */
export const BRANCH_WINDOW = 30

export interface PullTestSuite {
  suite: string
  passed: number
  failed: number
  skipped: number
  mutedFailures: number
  verdict: string
  at: string | null
}

export interface PullTestFinding {
  id: number
  suite: string
  scope: string
  name: string
  message: string | null
  /** Muted: still reported, still counted here, not counted against the run. */
  muted: boolean
}

export interface PullTestSummary {
  /** Whether any results have been reported for this head at all. */
  reported: boolean
  suites: PullTestSuite[]
  failures: PullTestFinding[]
  /** Unreliable on this branch, and not on the base. This branch did it. */
  newlyFlaky: PullTestFinding[]
  /** Unreliable on this branch and already unreliable on the base. Not yours. */
  alreadyFlaky: PullTestFinding[]
  counts: { passed: number, failed: number, skipped: number, mutedFailures: number }
  verdict: 'passed' | 'failed' | 'unknown'
}

/**
 * The summary for one pull request.
 *
 * Keyed on the head *commit*, not the branch: a branch moves while somebody is
 * reading the page, and a summary that quietly reflects a newer push is a
 * summary that disagrees with the diff beside it.
 */
export async function testSummaryForPull(input: {
  repositoryId: number
  headSha: string
  headBranch: string
  baseBranch: string
}): Promise<PullTestSummary> {
  const empty: PullTestSummary = {
    reported: false,
    suites: [],
    failures: [],
    newlyFlaky: [],
    alreadyFlaky: [],
    counts: { passed: 0, failed: 0, skipped: 0, mutedFailures: 0 },
    verdict: 'unknown',
  }

  if (!input.repositoryId || !input.headSha)
    return empty

  /*
   * The latest run per suite for this commit.
   *
   * Per suite because a repository reports several - unit, browser, e2e - and
   * the latest overall would let a fast suite hide a slow one that has not
   * finished. Latest *within* a suite because a rerun supersedes the run it
   * repeated.
   */
  const runs = await db
    .selectFrom('test_runs')
    .innerJoin('test_suites', 'test_suites.id', '=', 'test_runs.test_suite_id')
    .select([
      'test_runs.id as id',
      'test_runs.passed as passed',
      'test_runs.failed as failed',
      'test_runs.skipped as skipped',
      'test_runs.muted_failures as muted_failures',
      'test_runs.created_at as at',
      'test_suites.slug as suite',
    ])
    .where('test_suites.repository_id', '=', input.repositoryId)
    .where('test_runs.head_sha', '=', input.headSha)
    .orderBy('test_runs.id', 'desc')
    .execute()
    .catch(() => [])

  if (!runs.length)
    return empty

  const latest = new Map<string, any>()

  for (const run of runs) {
    const suite = String(run.suite)

    if (!latest.has(suite))
      latest.set(suite, run)
  }

  const summary: PullTestSummary = { ...empty, reported: true, suites: [], failures: [] }

  for (const run of latest.values()) {
    const failed = Number(run.failed ?? 0)
    const muted = Number(run.muted_failures ?? 0)

    summary.suites.push({
      suite: String(run.suite),
      passed: Number(run.passed ?? 0),
      failed,
      skipped: Number(run.skipped ?? 0),
      mutedFailures: muted,
      // A muted failure is already excluded from `failed` at ingestion, so a
      // suite whose only failures are muted reads as passed here too - which
      // is the whole of what muting a test does.
      verdict: failed > 0 ? 'failed' : 'passed',
      at: run.at ? String(run.at) : null,
    })

    summary.counts.passed += Number(run.passed ?? 0)
    summary.counts.failed += failed
    summary.counts.skipped += Number(run.skipped ?? 0)
    summary.counts.mutedFailures += muted
  }

  summary.verdict = summary.counts.failed > 0 ? 'failed' : 'passed'

  const runIds = [...latest.values()].map(run => Number(run.id))

  const executions = await db
    .selectFrom('test_executions')
    .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'managed_tests.id as id',
      'managed_tests.name as name',
      'managed_tests.scope as scope',
      'managed_tests.state as state',
      'test_executions.result as result',
      'test_executions.retries as retries',
      'test_executions.failure_message as failure_message',
      'test_suites.slug as suite',
    ])
    .where('test_executions.test_run_id', 'in', runIds)
    .execute()
    .catch(() => [])

  const interesting = new Map<number, PullTestFinding>()

  for (const row of executions) {
    const finding: PullTestFinding = {
      id: Number(row.id),
      suite: String(row.suite),
      scope: String(row.scope ?? ''),
      name: String(row.name),
      message: row.failure_message ? String(row.failure_message) : null,
      muted: String(row.state) === 'muted',
    }

    if (String(row.result) === 'failed')
      summary.failures.push(finding)

    /*
     * A candidate for "unreliable" is any test that failed here, or passed
     * only after a retry. Reading every test's branch history to find the
     * quiet ones would be a query per test in the suite, for an answer that is
     * almost always "fine".
     */
    if (String(row.result) === 'failed' || Number(row.retries ?? 0) > 0)
      interesting.set(finding.id, finding)
  }

  for (const [id, finding] of interesting) {
    const onHead = await unreliableOn(id, input.headBranch)

    if (!onHead)
      continue

    // The distinction the whole function exists for: the base's history is
    // read with the same rule, so "already flaky" means measurably so rather
    // than flagged at some point by somebody.
    if (await unreliableOn(id, input.baseBranch))
      summary.alreadyFlaky.push(finding)
    else
      summary.newlyFlaky.push(finding)
  }

  return summary
}

/**
 * Whether a test disagrees with itself on one branch.
 *
 * The same two shapes ingestion uses - passed and failed on one commit, or
 * passed only after a retry - deliberately, so the pull request cannot call
 * something flaky that the test list does not, or the reverse.
 */
async function unreliableOn(testId: number, branch: string): Promise<boolean> {
  if (!branch)
    return false

  const rows = await db
    .selectFrom('test_executions')
    .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
    .select([
      'test_executions.result as result',
      'test_executions.retries as retries',
      'test_runs.head_sha as head_sha',
    ])
    .where('test_executions.managed_test_id', '=', testId)
    .where('test_runs.branch', '=', branch)
    .orderBy('test_executions.id', 'desc')
    .limit(BRANCH_WINDOW)
    .execute()
    .catch(() => [])

  if (!rows.length)
    return false

  const byCommit = new Map<string, Set<string>>()

  for (const row of rows)
    byCommit.set(String(row.head_sha), (byCommit.get(String(row.head_sha)) ?? new Set()).add(String(row.result)))

  const disagreed = [...byCommit.values()].some(results => results.has('passed') && results.has('failed'))
  const retried = rows.some(row => String(row.result) === 'passed' && Number(row.retries ?? 0) > 0)

  return disagreed || retried
}
