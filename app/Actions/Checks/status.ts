/**
 * Combining check runs into the one answer a merge button needs.
 *
 * A commit has many checks and a branch rule names the ones it requires. The
 * question "can this merge" has to survive the awkward cases: a required check
 * that has not reported at all, a check that reported twice because CI retried,
 * a neutral result, and a check that was cancelled because a newer commit
 * arrived.
 *
 * Getting this wrong in the permissive direction merges unverified code, and in
 * the strict direction blocks every pull request on a check nobody runs any
 * more. Both happen; hence the tests.
 */

/** The states a check run can be in, from the API a runner reports to. */
export const CHECK_STATUSES = ['queued', 'in_progress', 'completed'] as const
export type CheckStatus = typeof CHECK_STATUSES[number]

export const CHECK_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'skipped',
  'stale',
] as const
export type CheckConclusion = typeof CHECK_CONCLUSIONS[number]

export interface CheckRun {
  name: string
  status: CheckStatus
  conclusion: CheckConclusion | null
  /** Higher wins when the same check reports more than once. */
  startedAt: number
}

/** The single state shown next to a commit. */
export type CombinedState = 'success' | 'failure' | 'pending' | 'neutral'

/**
 * The latest run of each check.
 *
 * CI retries, and a re-run means the earlier result is history rather than a
 * second opinion. Without this, one failed attempt keeps a commit red forever.
 */
export function latestRuns(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>()

  for (const run of runs) {
    const held = latest.get(run.name)
    if (!held || run.startedAt >= held.startedAt)
      latest.set(run.name, run)
  }

  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Whether a finished run counts as passing.
 *
 * `neutral` and `skipped` pass: a check that decided it had nothing to say
 * about this commit has not found a problem, and treating it as a failure means
 * every path-filtered workflow blocks every unrelated pull request.
 *
 * `stale` and `cancelled` do not pass, but they are not failures either — see
 * `combinedState`, which treats them as unfinished.
 */
export function runPassed(run: CheckRun): boolean {
  if (run.status !== 'completed')
    return false

  return run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped'
}

function runFailed(run: CheckRun): boolean {
  if (run.status !== 'completed')
    return false

  return run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'action_required'
}

/**
 * The one state to show for a commit.
 *
 * A failure anywhere wins: showing green while something is red is the mistake
 * that costs trust in the indicator entirely.
 */
export function combinedState(runs: readonly CheckRun[]): CombinedState {
  const latest = latestRuns(runs)

  if (latest.length === 0)
    return 'neutral'

  if (latest.some(runFailed))
    return 'failure'

  // Cancelled and stale are neither pass nor fail: something will report again.
  if (latest.some(run => run.status !== 'completed' || run.conclusion === 'cancelled' || run.conclusion === 'stale'))
    return 'pending'

  return 'success'
}

export interface RequirementResult {
  satisfied: boolean
  /** Required checks that failed. */
  failing: string[]
  /** Required checks still running or queued. */
  pending: string[]
  /** Required checks that never reported at all. */
  missing: string[]
}

/**
 * Whether the checks a branch rule requires are satisfied.
 *
 * A required check that has never reported is `missing`, not `pending`: the
 * difference matters to the person waiting, because pending resolves itself and
 * missing means the workflow is not wired up and never will.
 *
 * Checks that are not required are ignored entirely. An experimental job that
 * nobody has promoted to required must not block a merge.
 */
export function requirementsSatisfied(
  runs: readonly CheckRun[],
  required: readonly string[],
): RequirementResult {
  if (required.length === 0)
    return { satisfied: true, failing: [], pending: [], missing: [] }

  const latest = new Map(latestRuns(runs).map(run => [run.name, run]))

  const failing: string[] = []
  const pending: string[] = []
  const missing: string[] = []

  for (const name of required) {
    const run = latest.get(name)

    if (!run) {
      missing.push(name)
      continue
    }

    if (runFailed(run)) {
      failing.push(name)
      continue
    }

    if (runPassed(run))
      continue

    // Queued, running, cancelled, or stale: not an answer yet.
    pending.push(name)
  }

  return {
    satisfied: failing.length === 0 && pending.length === 0 && missing.length === 0,
    failing,
    pending,
    missing,
  }
}

/**
 * A one-line summary for the merge box.
 *
 * Written out rather than assembled from fragments, because this is the
 * sentence somebody reads when they cannot merge and it has to say what to do.
 */
export function requirementSummary(result: RequirementResult): string {
  if (result.satisfied)
    return 'All required checks have passed'

  if (result.failing.length > 0)
    return `Required ${result.failing.length === 1 ? 'check' : 'checks'} failed: ${result.failing.join(', ')}`

  if (result.missing.length > 0)
    return `Waiting for ${result.missing.join(', ')} to report for the first time`

  return `Waiting for ${result.pending.join(', ')}`
}

/**
 * Mark the runs of a superseded commit stale.
 *
 * When a branch moves, the checks that ran against the old head describe code
 * nobody is merging. Leaving them green is how a force push slips past a
 * required check.
 */
export function staleRunsFor(runs: readonly CheckRun[], headSha: string, runShas: readonly string[]): number[] {
  const indexes: number[] = []

  runs.forEach((run, index) => {
    if (runShas[index] !== headSha && run.conclusion !== 'stale')
      indexes.push(index)
  })

  return indexes
}

/**
 * A commit status, as a check run for the purpose of a branch rule.
 *
 * Required checks are named strings, and a branch rule cannot know which of the
 * two reporting APIs will answer to a name. Until this existed, only
 * `check_runs` were consulted - so a CI system posting under the *status* API,
 * which is the older and simpler one and what most existing integrations use,
 * satisfied nothing. A repository requiring `ci/build` while its CI posted
 * `ci/build` as a status waited forever, and the page said "has never
 * reported" about a check that had just reported.
 *
 * Mapped onto the existing shape rather than given a second rule of its own, so
 * a status and a run under one name are compared by the same code. A status has
 * no attempts, so recency is its timestamp - which is what `latestRuns` already
 * expects for anything without one.
 */
export function statusAsRun(row: { context?: unknown, state?: unknown, created_at?: unknown }): CheckRun {
  const state = String(row.state ?? 'pending')

  return {
    name: String(row.context ?? ''),
    status: state === 'pending' ? 'in_progress' : 'completed',
    conclusion: state === 'pending' ? null : state === 'success' ? 'success' : 'failure',
    startedAt: Date.parse(String(row.created_at ?? '')) || 0,
  }
}
