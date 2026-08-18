/**
 * Who hears about a run, and when.
 *
 * The rules are matched here, purely, because this is the part that decides
 * whether somebody's phone buzzes at three in the morning. A rule set that
 * cannot be tested without a database and a finished run is a rule set nobody
 * tests against the case that matters - which is `recovery`, the first success
 * after a failure, and the one every other implementation gets wrong by
 * treating "not failed" as "recovered".
 */

export type NotifyCondition = 'failure' | 'success' | 'recovery' | 'always'

export interface NotificationRule {
  id?: number
  userId: number
  /** A glob over the workflow's path or name. `*` for every workflow. */
  workflow: string
  /** A glob over the branch, with no `refs/heads/`. `*` for every branch. */
  branch: string
  /** One job's key, or empty for the run as a whole. */
  jobKey: string
  condition: NotifyCondition
}

export interface RunOutcome {
  /** The workflow's path, so a rule may name either the path or the file. */
  workflowPath: string
  workflowName: string
  /** The branch, already stripped of `refs/heads/`. */
  branch: string
  /** `succeeded`, `failed`, `cancelled`. */
  state: string
  /**
   * How the previous run of this workflow on this branch ended.
   *
   * The whole of `recovery`. Null when there was no previous run, and that is
   * deliberately *not* a recovery: the first run of a new workflow going green
   * is not something anybody asked to be told about.
   */
  previousState: string | null
  /** The jobs that ended, so a per-job rule can name one. */
  jobs: Array<{ key: string, state: string, previousState: string | null }>
}

/**
 * A glob, as narrow as it needs to be.
 *
 * `*` matches anything, `release/*` matches a path segment or several, and
 * everything else is an exact match. Deliberately not a full glob library: the
 * two shapes above are what a person writes in this box, and a matcher with
 * more shapes than that is a matcher whose surprises land as a missed alert.
 */
export function globMatches(pattern: string, value: string): boolean {
  const glob = String(pattern ?? '').trim()
  const text = String(value ?? '')

  if (!glob || glob === '*')
    return true

  if (!glob.includes('*'))
    return glob === text

  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

  return new RegExp(`^${escaped}$`).test(text)
}

/** Whether a state and the one before it satisfy a condition. */
export function conditionHolds(condition: NotifyCondition, state: string, previousState: string | null): boolean {
  const failed = state === 'failed' || state === 'cancelled'
  const succeeded = state === 'succeeded'

  if (condition === 'always')
    return failed || succeeded

  if (condition === 'failure')
    return failed

  if (condition === 'success')
    return succeeded

  /*
   * `recovery`: green now, not green before, and there *was* a before.
   *
   * A first run going green is not a recovery - nothing was broken - and
   * treating it as one is how a new workflow's first success wakes somebody up.
   */
  return succeeded && previousState !== null && previousState !== 'succeeded'
}

export interface NotificationMatch {
  rule: NotificationRule
  /** The job this is about, or empty for the run. */
  jobKey: string
  /** What happened, in the words the notification uses. */
  state: string
}

/**
 * Which rules this outcome satisfies.
 *
 * At most one notification per person per run, and that cap is the feature: a
 * repository with a rule for the run and a rule for each of three jobs would
 * otherwise send four messages about one push, which is how somebody ends up
 * muting the whole repository. The narrowest match wins - a rule naming a job
 * beats one naming the run - because the person who wrote the narrower rule
 * said what they cared about.
 */
export function matchRules(rules: readonly NotificationRule[], outcome: RunOutcome): NotificationMatch[] {
  const best = new Map<number, NotificationMatch>()

  for (const rule of rules) {
    const workflowMatches = globMatches(rule.workflow, outcome.workflowPath)
      || globMatches(rule.workflow, outcome.workflowName)
      // The file name alone, which is what people paste: `deploy.yml` should
      // match `.github/workflows/deploy.yml` without anybody typing the path.
      || globMatches(rule.workflow, outcome.workflowPath.split('/').pop() ?? '')

    if (!workflowMatches || !globMatches(rule.branch, outcome.branch))
      continue

    if (rule.jobKey) {
      const job = outcome.jobs.find(one => one.key === rule.jobKey)

      if (!job || !conditionHolds(rule.condition, job.state, job.previousState))
        continue

      best.set(rule.userId, { rule, jobKey: job.key, state: job.state })
      continue
    }

    if (!conditionHolds(rule.condition, outcome.state, outcome.previousState))
      continue

    // A run-wide match does not displace a job-specific one already found.
    if (!best.get(rule.userId)?.jobKey)
      best.set(rule.userId, { rule, jobKey: '', state: outcome.state })
  }

  return [...best.values()]
}

/** The sentence a notification carries, which is the whole of what most people read. */
export function notificationTitle(input: {
  repository: string
  runNumber: number
  workflowName: string
  jobKey: string
  state: string
  recovered: boolean
}): string {
  const what = input.jobKey ? `${input.workflowName} / ${input.jobKey}` : input.workflowName

  if (input.recovered)
    return `${what} is passing again in ${input.repository} run #${input.runNumber}`

  return `${what} ${input.state} in ${input.repository} run #${input.runNumber}`
}
