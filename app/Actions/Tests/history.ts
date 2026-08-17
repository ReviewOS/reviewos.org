import { db } from '@stacksjs/database'
import { splitTests } from './split'
import type { SplitOutcome } from './split'

/**
 * The split, computed from a repository's recorded timings.
 *
 * Shared by the two endpoints that answer it - one for a caller with a
 * repository credential, one for a job running here that has only its job token
 * - because the *answer* must not depend on which door the question came
 * through. Two implementations that drift is how one node gets a different
 * partition from another.
 */
export async function splitForRepository(input: {
  repositoryId: number
  suite: string
  items: readonly string[]
  nodes: number
  index: number
}): Promise<SplitOutcome> {
  /*
   * Timing is per *scope* - the file - because that is the unit a test runner
   * takes on its command line. Splitting by individual test would give a
   * better partition and a client nobody can write.
   */
  const rows: any[] = await db
    .selectFrom('test_executions')
    .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'managed_tests.scope as scope',
      db.fn.sum('test_executions.duration_ms').as('total'),
      db.fn.count('test_executions.id').as('samples'),
    ])
    .where('test_suites.repository_id', '=', input.repositoryId)
    .where('test_suites.slug', '=', input.suite)
    // A skipped test costs nothing to run, so counting its history would make
    // the file holding it look slower than it will be.
    .where('managed_tests.state', '!=', 'skipped')
    .groupBy('managed_tests.scope')
    .execute()
    .catch(() => [])

  /*
   * Divided by the number of runs those executions came from, not left as a
   * sum: a file that has been in the suite for six months has six months of
   * executions behind it, and a sum would make age look like slowness.
   */
  const runs = await runCount(input.repositoryId, input.suite)
  const history = new Map<string, { total: number, samples: number }>()

  for (const row of rows) {
    const scope = String(row.scope ?? '')

    if (scope)
      history.set(scope, { total: Number(row.total ?? 0), samples: Number(row.samples ?? 0) })
  }

  return splitTests({
    nodes: input.nodes,
    index: input.index,
    items: input.items.map((name) => {
      const seen = history.get(name)

      return {
        name,
        durationMs: seen ? seen.total / Math.max(1, runs) : 0,
        samples: seen?.samples ?? 0,
      }
    }),
  })
}

/** How many runs the history spans, so a sum can become a per-run average. */
async function runCount(repositoryId: number, suite: string): Promise<number> {
  const row: any = await db
    .selectFrom('test_runs')
    .innerJoin('test_suites', 'test_suites.id', '=', 'test_runs.test_suite_id')
    .select(db.fn.count('test_runs.id').as('runs'))
    .where('test_suites.repository_id', '=', repositoryId)
    .where('test_suites.slug', '=', suite)
    .executeTakeFirst()
    .catch(() => null)

  return Math.max(1, Number(row?.runs ?? 1))
}

/** The client's list, as JSON, as newline-separated text, or as an array. */
export function itemsFrom(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      // `find test -name '*.spec.ts'` produces lines, and asking somebody to
      // turn lines into a JSON array in shell is asking for `jq -R -s`.
      ? value.split('\n')
      : []

  const seen = new Set<string>()

  for (const one of raw) {
    const name = String(one ?? '').trim()

    // Deduplicated here rather than trusted: a client that lists a file twice
    // would otherwise get it on two nodes, which is the exact failure the
    // partition is careful to avoid everywhere else.
    if (name)
      seen.add(name)
  }

  return [...seen].slice(0, 20_000)
}
