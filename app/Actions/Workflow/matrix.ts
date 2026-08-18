/**
 * A job's matrix, expanded the way GitHub Actions expands it.
 *
 * This is the part of workflow syntax that looks simple and is not. `include`
 * does two different things depending on whether its entry matches an existing
 * combination, `exclude` is applied before `include` rather than after, and the
 * order combinations come out in is observable - it is the order the jobs
 * appear in, and somebody's run screen is sorted by it.
 *
 * Getting it wrong is not a parse error. It is the wrong number of jobs, or the
 * right number with one of them carrying the wrong Node version, which shows up
 * as a test suite that passes when it should not.
 *
 * The rules, in the order they apply:
 *
 * 1. The **cartesian product** of every key that is not `include` or `exclude`,
 *    varying the *last* key fastest.
 * 2. **`exclude` removes** any combination that matches every key it names. A
 *    partial match is a match: `exclude: [{ os: windows }]` removes every
 *    Windows combination.
 * 3. **`include` adds or extends.** For each entry, if it can be merged into an
 *    existing combination without overwriting any value already there, it is
 *    merged into every such combination. Otherwise it is appended as a
 *    combination of its own. An include entry is never removed by `exclude`.
 */

/** One value a matrix key can take. Actions allows scalars and objects. */
export type MatrixValue = string | number | boolean | null | Record<string, unknown>

/** One expanded combination: every key with the value this job gets. */
export type Combination = Record<string, MatrixValue>

export interface MatrixDefinition {
  [key: string]: unknown
  include?: Combination[]
  exclude?: Combination[]
}

/** Actions' own ceiling. A matrix past this is refused rather than run. */
export const MAX_COMBINATIONS = 256

export interface ExpandResult {
  combinations: Combination[]
  /** Named rather than thrown: a workflow with one bad job still runs its others. */
  problem?: string
}

/** Whether two values are the same as far as a matrix is concerned. */
function same(left: unknown, right: unknown): boolean {
  if (left === right)
    return true

  // Objects appear as matrix values often enough to matter - a `{ node: 20,
  // experimental: true }` entry is idiomatic - and comparing them by identity
  // would make every exclude miss.
  if (left && right && typeof left === 'object' && typeof right === 'object')
    return JSON.stringify(left) === JSON.stringify(right)

  return false
}

/** Whether `combination` matches every key the filter names. */
export function matches(combination: Combination, filter: Combination): boolean {
  return Object.entries(filter).every(([key, value]) => same(combination[key], value))
}

/**
 * The cartesian product, last key varying fastest.
 *
 * The order is not an implementation detail: it decides the order jobs appear
 * in a run, and Actions' order is what somebody comparing two forges will
 * notice first.
 */
export function product(keys: Array<[string, MatrixValue[]]>): Combination[] {
  let combinations: Combination[] = [{}]

  for (const [key, values] of keys) {
    const next: Combination[] = []

    for (const combination of combinations) {
      for (const value of values)
        next.push({ ...combination, [key]: value })
    }

    combinations = next
  }

  return combinations
}

/** A matrix value list, from whatever the YAML held. */
function asList(value: unknown): MatrixValue[] {
  if (Array.isArray(value))
    return value as MatrixValue[]

  // A scalar is a one-value axis rather than a mistake: `matrix: { os: ubuntu }`
  // is a workflow that runs once, and refusing it would be stricter than
  // Actions for no gain.
  return [value as MatrixValue]
}

/**
 * Expand a matrix into the combinations a run will carry.
 *
 * Returns an empty list for a job with no matrix, which the caller reads as
 * "one job, no matrix values" rather than "no jobs".
 */
export function expandMatrix(matrix: MatrixDefinition | undefined | null): ExpandResult {
  if (!matrix || typeof matrix !== 'object')
    return { combinations: [] }

  const axes: Array<[string, MatrixValue[]]> = Object.entries(matrix)
    .filter(([key]) => key !== 'include' && key !== 'exclude')
    .map(([key, value]) => [key, asList(value)])

  const includes = Array.isArray(matrix.include) ? matrix.include : []
  const excludes = Array.isArray(matrix.exclude) ? matrix.exclude : []

  let combinations = axes.length > 0 ? product(axes) : []

  // Before include, deliberately. An entry added by `include` is not subject to
  // `exclude` - Actions says so, and a workflow that excludes a combination and
  // then includes it back expects the include to win.
  if (excludes.length > 0)
    combinations = combinations.filter(combination => !excludes.some(filter => matches(combination, filter)))

  for (const entry of includes) {
    if (!entry || typeof entry !== 'object')
      continue

    let merged = false

    for (let at = 0; at < combinations.length; at += 1) {
      const combination = combinations[at] as Combination

      /*
       * Mergeable when every key the entry shares with this combination
       * already has the same value. An entry that would *overwrite* a value is
       * not an extension of that combination; it is a new one.
       */
      const conflicts = Object.entries(entry)
        .some(([key, value]) => key in combination && !same(combination[key], value))

      if (conflicts)
        continue

      combinations[at] = { ...combination, ...entry }
      merged = true
    }

    if (!merged)
      combinations.push({ ...entry })
  }

  // An include on a job with no matrix keys is how a single extra job is
  // spelled, and it produced an empty product above.
  if (combinations.length === 0 && includes.length > 0)
    return { combinations: includes.map(entry => ({ ...entry })) }

  if (combinations.length > MAX_COMBINATIONS) {
    return {
      combinations: combinations.slice(0, MAX_COMBINATIONS),
      problem: `A matrix produces ${combinations.length} jobs, and ${MAX_COMBINATIONS} is the most a run will start. Narrow it, or split the workflow.`,
    }
  }

  return { combinations }
}

/**
 * A short name for one combination, for the run screen.
 *
 * Actions writes `build (ubuntu-latest, 20)` - the values, in the matrix's own
 * key order, without their keys. It reads better than `os=ubuntu-latest,
 * node=20` at the width a job list has, and it is what somebody scanning a
 * failed run is already used to.
 */
export function combinationLabel(combination: Combination): string {
  const parts = Object.values(combination).map((value) => {
    if (value === null)
      return 'null'

    if (typeof value === 'object')
      return JSON.stringify(value)

    return String(value)
  })

  return parts.join(', ')
}

/**
 * One combination singled out by name.
 *
 * Buildkite's `adjustments`, and the reason it exists: the useful matrix is
 * never the full cross product. One combination is known-broken and should not
 * run; another is expected to fail and should not fail the run. Actions can say
 * the first with `exclude` and cannot say the second at all - `continue-on-error`
 * is per *job*, so tolerating one combination means tolerating all of them.
 */
export interface MatrixAdjustment {
  /** The values that identify the combination. A partial match is a match. */
  with: Combination
  /** Why it is skipped, when it is. */
  skip?: string | null
  /** Whether this combination's failure is tolerated. */
  softFail?: boolean
}

/**
 * The adjustment that applies to a combination, or null.
 *
 * **The last match wins**, which is the rule people expect from a list of
 * overrides and the one that makes a broad adjustment followed by a narrow one
 * mean what it reads as: `{ os: windows } soft-fail` then
 * `{ os: windows, node: 22 } skip` skips exactly that one and tolerates the
 * rest.
 */
export function adjustmentFor(
  combination: Combination,
  adjustments: readonly MatrixAdjustment[],
): MatrixAdjustment | null {
  let found: MatrixAdjustment | null = null

  for (const adjustment of adjustments) {
    // An adjustment with no `with:` matches everything, which is somebody
    // writing a job-level setting in the wrong place rather than an intent.
    if (Object.keys(adjustment.with ?? {}).length === 0)
      continue

    if (matches(combination, adjustment.with))
      found = adjustment
  }

  return found
}
