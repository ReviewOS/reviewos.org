/**
 * One answer from every check on a commit.
 *
 * Two APIs report here - the old commit statuses and the newer check runs - and
 * a pull request has to show one verdict rather than two lists that disagree.
 * This is the rule that combines them, and it is written to be read by somebody
 * deciding whether to trust it, because getting it wrong is expensive in both
 * directions: permissive merges unverified code, strict blocks every pull
 * request on a check nobody runs any more.
 *
 * ## The rule
 *
 * 1. **A failure wins.** Any failed or errored report makes the whole thing
 *    failing, however many others passed. A commit is not "mostly verified".
 * 2. **An unfinished report is pending**, and pending beats success. A check
 *    still running has not said anything yet, and treating silence as consent
 *    is the whole failure mode.
 * 3. **No reports at all is neutral, not success.** This is the one people get
 *    wrong. A commit nothing has looked at is green in most forges, which means
 *    a repository whose CI is misconfigured looks exactly like one whose tests
 *    all pass - and the difference is only noticed after something ships.
 *
 * ## Latest per name
 *
 * A CI system posts `pending` then `success` under one name, and re-runs post
 * again. Only the newest attempt of each name counts, or a re-run that fixed
 * the build would leave the original failure winning forever.
 */

export type RollupState = 'failure' | 'pending' | 'success' | 'neutral'

export interface Report {
  /** The context or check name, which is what "latest per name" is keyed on. */
  name: string
  state: RollupState
  /** Higher is newer. An attempt number, or a timestamp in milliseconds. */
  order: number
  /** Where it came from, for a page that has to explain a disagreement. */
  source: 'status' | 'check_run'
}

/** A commit status row as a report. `error` and `failure` mean the same here. */
export function fromStatus(row: { context?: unknown, state?: unknown, created_at?: unknown }, order?: number): Report {
  const state = String(row.state ?? 'pending')

  return {
    name: String(row.context ?? ''),
    state: state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure',
    order: order ?? (Date.parse(String(row.created_at ?? '')) || 0),
    source: 'status',
  }
}

/**
 * A check run row as a report.
 *
 * A run that has not completed is pending whatever its conclusion field says -
 * a conclusion on an unfinished run is a value nobody should be reading, and
 * treating it as final is how a check that is still running lets a merge
 * through.
 *
 * `skipped` and `neutral` are successes for the purpose of a merge: the check
 * ran, looked, and declined to object. `cancelled` and `timed_out` are not -
 * nothing looked, and a cancelled check silently counting as a pass is exactly
 * how a superseded run unblocks a commit nobody verified.
 */
export function fromCheckRun(row: {
  name?: unknown
  status?: unknown
  conclusion?: unknown
  attempt?: unknown
  completed_at?: unknown
}): Report {
  const status = String(row.status ?? 'queued')
  const conclusion = String(row.conclusion ?? '')

  let state: RollupState = 'pending'

  if (status === 'completed') {
    if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped')
      state = 'success'
    else if (conclusion === '')
      // Completed with no conclusion is a reporter bug, and the safe reading is
      // that nothing was concluded rather than that everything is fine.
      state = 'neutral'
    else
      state = 'failure'
  }

  return {
    name: String(row.name ?? ''),
    state,
    order: Number(row.attempt) || (Date.parse(String(row.completed_at ?? '')) || 0),
    source: 'check_run',
  }
}

/**
 * The newest report under each name.
 *
 * Ties break towards the *later* entry in the list, which callers pass newest
 * last. Two reports with the same order under one name is a CI system posting
 * twice in the same millisecond, and either is defensible - what is not is
 * picking differently on two page loads.
 */
export function latestPerName(reports: readonly Report[]): Report[] {
  const newest = new Map<string, Report>()

  for (const report of reports) {
    const held = newest.get(report.name)

    if (!held || report.order >= held.order)
      newest.set(report.name, report)
  }

  return [...newest.values()]
}

export interface Rollup {
  state: RollupState
  /** What each name last said, for a page that lists them. */
  reports: Report[]
  counts: Record<RollupState, number>
}

/** Every report on a commit, combined into the one answer a merge needs. */
export function rollup(reports: readonly Report[]): Rollup {
  const latest = latestPerName(reports)

  const counts: Record<RollupState, number> = { failure: 0, pending: 0, success: 0, neutral: 0 }

  for (const report of latest)
    counts[report.state] += 1

  // The order of these three is the rule, and it is the whole file.
  const state: RollupState = counts.failure > 0
    ? 'failure'
    : counts.pending > 0
      ? 'pending'
      : latest.length === 0 || counts.success === 0
        ? 'neutral'
        : 'success'

  return { state, reports: latest.sort((a, b) => a.name.localeCompare(b.name)), counts }
}

/**
 * Whether a set of required names is satisfied.
 *
 * A required check that has never reported is **missing**, and missing blocks.
 * That is the case a branch rule exists for: somebody adds `security/scan` to
 * the required list before the scanner is wired up, and every pull request
 * waits rather than merging on a check that does not exist yet.
 */
export function requiredSatisfied(reports: readonly Report[], required: readonly string[]): {
  ok: boolean
  missing: string[]
  failing: string[]
  pending: string[]
} {
  const latest = new Map(latestPerName(reports).map(report => [report.name, report]))

  const missing: string[] = []
  const failing: string[] = []
  const pending: string[] = []

  for (const name of required) {
    const report = latest.get(name)

    if (!report)
      missing.push(name)
    else if (report.state === 'failure')
      failing.push(name)
    else if (report.state !== 'success')
      pending.push(name)
  }

  return { ok: missing.length === 0 && failing.length === 0 && pending.length === 0, missing, failing, pending }
}
