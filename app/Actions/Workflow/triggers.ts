/**
 * Whether a push starts a run.
 *
 * All of it is a decision over data the caller already has - a ref, a list of
 * changed paths, a set of filters - so none of it touches the database or git.
 * That is deliberate: this runs on every push to every repository, and it is
 * also the thing most likely to be wrong in a way nobody notices, because a
 * filter that matches too little produces *no* run and there is nothing on
 * screen to look at.
 *
 * The patterns are GitHub's, because the format is. Three characters matter and
 * the difference between two of them is the one people get wrong:
 *
 * - `*` matches within a path segment and stops at `/`
 * - `**` crosses separators
 * - `?` is one character
 *
 * So `docs/*` does not match `docs/api/index.md` and `docs/**` does. Getting
 * that backwards is the single most common CI filter bug, and it is silent in
 * the direction that skips the run.
 */

/** A filter as it comes off a workflow version: one pattern per line. */
export function patternsFrom(stored: string | null | undefined): string[] {
  return String(stored ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Does one glob match one path?
 *
 * Compiled to a regular expression rather than walked, because the same handful
 * of patterns run against every changed path in a push and a compiled pattern
 * is reusable where a walk is not.
 */
export function globMatches(pattern: string, value: string): boolean {
  return compile(pattern).test(value)
}

const cache = new Map<string, RegExp>()

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached)
    return cached

  let expression = '^'

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!

    if (character === '*') {
      // `**` crosses separators; a single `*` stops at one. The trailing `/`
      // of `docs/**/` is consumed with it so `docs/**` matches `docs/a` as
      // well as `docs/a/b`.
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/')
          index++
        expression += '.*'
      }
      else {
        expression += '[^/]*'
      }
      continue
    }

    if (character === '?') {
      expression += '[^/]'
      continue
    }

    expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  const compiled = new RegExp(`${expression}$`)
  cache.set(pattern, compiled)
  return compiled
}

/**
 * Does a ref pass a set of name filters?
 *
 * **No filters means yes**, which is Actions' rule and the one that matters:
 * `on: push` with no `branches:` runs on every branch, and reading an empty
 * list as "matches nothing" would silently disable every workflow that did not
 * name one.
 *
 * A leading `!` excludes. Actions' own precedence applies: if any negative
 * pattern matches, the ref is out, whatever the positive ones say.
 */
export function refMatches(patterns: readonly string[], name: string): boolean {
  if (patterns.length === 0)
    return true

  const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const positive = patterns.filter(pattern => !pattern.startsWith('!'))

  if (negative.some(pattern => globMatches(pattern, name)))
    return false

  // Only exclusions were given, and none matched: everything else is included.
  if (positive.length === 0)
    return true

  return positive.some(pattern => globMatches(pattern, name))
}

/**
 * Does a push touch anything a path filter cares about?
 *
 * One changed path matching is enough - a push is a set of changes and a
 * workflow that watches `src/**` wants to run when any of it moved.
 *
 * **An empty `paths:` means yes; an empty list of changed paths means no.**
 * Those look similar and are opposites. The first is "this workflow does not
 * filter by path". The second is a push that changed nothing this workflow
 * watches, and running then is how a repository gets a green tick for a diff
 * that never happened.
 */
export function pathsMatch(patterns: readonly string[], changed: readonly string[]): boolean {
  if (patterns.length === 0)
    return true

  const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const positive = patterns.filter(pattern => !pattern.startsWith('!'))

  return changed.some((path) => {
    if (negative.some(pattern => globMatches(pattern, path)))
      return false

    return positive.length === 0 || positive.some(pattern => globMatches(pattern, path))
  })
}

/** The trigger state a dispatch decision needs, as stored on a version. */
export interface VersionTriggers {
  on_push?: boolean | null
  push_branches?: string | null
  push_tags?: string | null
  push_paths?: string | null
  /**
   * The negative filters, which are not the positive ones inverted.
   *
   * Actions refuses a workflow that sets both forms for one event, so at most
   * one of each pair is populated. What they change is the *default*: with
   * `branches`, a branch runs only if it matches; with `branches-ignore`, every
   * branch runs except the ones that do.
   */
  push_branches_ignore?: string | null
  push_tags_ignore?: string | null
  push_paths_ignore?: string | null
}

export interface PushEvent {
  /** The full ref, `refs/heads/main` or `refs/tags/v1.0.0`. */
  ref: string
  /** Paths this push changed. Empty when nothing is known about them. */
  changed?: readonly string[]
  /** A deletion introduces no commits and starts nothing. */
  deleted?: boolean
  /**
   * The head commit's message, for a job's `if:`.
   *
   * `[skip ci]` and `contains(github.event.head_commit.message, 'deploy')` are
   * the two things people actually write with it, and both are unanswerable
   * without carrying the message this far.
   */
  message?: string
}

export interface TriggerDecision {
  run: boolean
  /** Why, in words, for the interface and for a test to assert on. */
  reason: string
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`, anything else → null. */
export function refName(ref: string): { kind: 'branch' | 'tag', name: string } | null {
  if (ref.startsWith('refs/heads/'))
    return { kind: 'branch', name: ref.slice('refs/heads/'.length) }

  if (ref.startsWith('refs/tags/'))
    return { kind: 'tag', name: ref.slice('refs/tags/'.length) }

  return null
}

export interface PullRequestVersionTriggers {
  on_pull_request?: boolean | null
  on_pull_request_target?: boolean | null
  pull_request_branches?: string | null
  pull_request_paths?: string | null
  pull_request_branches_ignore?: string | null
  pull_request_paths_ignore?: string | null
  /** `types: [opened, synchronize]`, one per line. Empty means Actions' default three. */
  pull_request_types?: string | null
}

export interface PullRequestEvent {
  /**
   * What happened to the pull request: `opened`, `synchronize`, `reopened`,
   * `closed`, `ready_for_review`.
   *
   * Actions calls these activity types, and a workflow that names none gets
   * the default three - which is why the default matters as much as the list.
   */
  activity: string
  /** The branch the pull request would merge into, without `refs/heads/`. */
  baseBranch: string
  /** The source branch, for `${{ github.head_ref }}` in a concurrency group. */
  headBranch?: string
  /** Paths the pull request changes. Empty when nothing is known about them. */
  changed?: readonly string[]
  /** Whether the head is a fork of this repository, which decides trust. */
  fromFork?: boolean
  /** A draft is not ready for review, and Actions does not run on it by default. */
  draft?: boolean
}

/**
 * The activity types Actions runs on when a workflow names none.
 *
 * Naming this rather than inlining it: a workflow that says `on: pull_request`
 * with no `types` is the overwhelmingly common case, and the reason it does not
 * run when somebody closes a pull request is this list rather than a bug.
 */
export const DEFAULT_PULL_REQUEST_ACTIVITIES = ['opened', 'synchronize', 'reopened'] as const

/**
 * Should this pull request event start a run of this version?
 *
 * The trust question is deliberately *not* here: this answers whether the
 * workflow asked for the event, and `dispatchPullRequest` decides what the run
 * is allowed to do. Mixing them would mean a fork check that a caller could
 * forget, which is the shape of every published Actions breach.
 */
export function pullRequestStartsRun(
  version: PullRequestVersionTriggers,
  event: PullRequestEvent,
  options: { target?: boolean } = {},
): TriggerDecision {
  const wanted = options.target ? version.on_pull_request_target : version.on_pull_request
  const name = options.target ? 'pull_request_target' : 'pull_request'

  if (!wanted)
    return { run: false, reason: `the workflow does not trigger on ${name}` }

  const activities = patternsFrom(version.pull_request_types ?? null)
  const allowed = activities.length > 0 ? activities : [...DEFAULT_PULL_REQUEST_ACTIVITIES]

  if (!allowed.includes(event.activity))
    return { run: false, reason: `${name} ${event.activity} is not one of the activity types this workflow runs on` }

  /*
   * A draft is work in progress, and Actions does not run on it unless the
   * workflow asks for `ready_for_review`. Running would burn a runner on every
   * keystroke of somebody thinking out loud.
   */
  if (event.draft && !allowed.includes('ready_for_review'))
    return { run: false, reason: 'the pull request is a draft' }

  const branches = patternsFrom(version.pull_request_branches)
  const branchesIgnore = patternsFrom(version.pull_request_branches_ignore)

  /*
   * The *base* branch, not the head.
   *
   * `branches:` on a pull request filters on where it is going, which is the
   * opposite of the instinct: a workflow that says `branches: [main]` means
   * "when something is proposed into main", not "when the contributor's branch
   * is called main".
   */
  if (branchesIgnore.length > 0 && refMatches(branchesIgnore, event.baseBranch))
    return { run: false, reason: `base branch ${event.baseBranch} is excluded by this workflow's branches-ignore` }

  if (branches.length > 0 && !refMatches(branches, event.baseBranch))
    return { run: false, reason: `base branch ${event.baseBranch} does not match this workflow's branch filter` }

  const paths = patternsFrom(version.pull_request_paths)
  const pathsIgnore = patternsFrom(version.pull_request_paths_ignore)

  if (paths.length > 0 || pathsIgnore.length > 0) {
    const changed = event.changed ?? []

    if (changed.length === 0)
      return { run: true, reason: 'nothing is known about what this pull request changes, and the workflow filters on paths' }

    if (pathsIgnore.length > 0 && changed.every(path => pathsMatch(pathsIgnore, [path])))
      return { run: false, reason: 'everything this pull request changes is excluded by paths-ignore' }

    if (paths.length > 0 && !pathsMatch(paths, changed))
      return { run: false, reason: 'nothing this pull request changes matches the path filter' }
  }

  return { run: true, reason: `${name} ${event.activity} into ${event.baseBranch}` }
}

/**
 * Should this push start a run of this workflow version?
 *
 * Returns the reason as well as the answer, because "no" is the outcome nobody
 * can see. A workflow that did not run leaves nothing on the screen to inspect,
 * and "no workflow matched this push" with no explanation is the support
 * question this product would otherwise generate forever.
 */
export function pushStartsRun(version: VersionTriggers, event: PushEvent): TriggerDecision {
  if (!version.on_push)
    return { run: false, reason: 'the workflow does not trigger on push' }

  if (event.deleted)
    return { run: false, reason: 'the ref was deleted, and a deletion introduces no commits' }

  const ref = refName(event.ref)
  if (!ref)
    return { run: false, reason: `${event.ref} is neither a branch nor a tag` }

  const branches = patternsFrom(version.push_branches)
  const tags = patternsFrom(version.push_tags)
  const branchesIgnore = patternsFrom(version.push_branches_ignore)
  const tagsIgnore = patternsFrom(version.push_tags_ignore)

  if (ref.kind === 'tag') {
    /*
     * A workflow that names branches and not tags is asking for branches. Tags
     * are opted into, which is Actions' behaviour and the safe direction: the
     * alternative runs every release tag through a workflow written for `main`.
     *
     * `tags-ignore` counts as naming tags. `on: push` with only
     * `tags-ignore: [v*]` means every tag but those, and reading it as "no tag
     * filter, so no tags" would silently never run.
     */
    if (tags.length === 0 && tagsIgnore.length === 0)
      return { run: false, reason: 'the push was a tag, and this workflow filters on branches' }

    if (tagsIgnore.length > 0 && refMatches(tagsIgnore, ref.name))
      return { run: false, reason: `tag ${ref.name} is excluded by this workflow's tags-ignore` }

    if (tags.length > 0 && !refMatches(tags, ref.name))
      return { run: false, reason: `tag ${ref.name} does not match this workflow's tag filter` }
  }
  else {
    if (branchesIgnore.length > 0 && refMatches(branchesIgnore, ref.name))
      return { run: false, reason: `branch ${ref.name} is excluded by this workflow's branches-ignore` }

    // With only an ignore list, everything not named runs - which is the whole
    // point of the negative form.
    if (branches.length > 0 && !refMatches(branches, ref.name))
      return { run: false, reason: `branch ${ref.name} does not match this workflow's branch filter` }

    if (branches.length === 0 && branchesIgnore.length === 0 && !refMatches(branches, ref.name))
      return { run: false, reason: `branch ${ref.name} does not match this workflow's branch filter` }
  }

  const paths = patternsFrom(version.push_paths)
  const pathsIgnore = patternsFrom(version.push_paths_ignore)

  if (paths.length > 0 || pathsIgnore.length > 0) {
    const changed = event.changed ?? []

    // Nothing known about what changed, and a filter that needs to know. Run
    // it: a missed run on a push that did touch the paths is a broken product,
    // and an extra run on one that did not is a wasted minute.
    if (changed.length === 0)
      return { run: true, reason: 'this push changed nothing we can see, and the workflow filters on paths' }

    /*
     * `paths-ignore` excludes a push only when *every* file it changed is
     * ignored. One source file alongside a hundred documentation changes is
     * still a source change, and Actions agrees: the filter is about pushes
     * that are entirely uninteresting, not about pushes that contain anything
     * uninteresting.
     */
    if (pathsIgnore.length > 0 && changed.every(path => pathsMatch(pathsIgnore, [path])))
      return { run: false, reason: 'everything this push changed is excluded by paths-ignore' }

    if (paths.length > 0 && !pathsMatch(paths, changed))
      return { run: false, reason: 'nothing this push changed matches the path filter' }
  }

  return { run: true, reason: `push to ${ref.kind} ${ref.name}` }
}

/**
 * The issue and release triggers.
 *
 * One shape for all three, because they filter on one thing: the activity
 * type. There is no branch on an issue and no path on a release.
 */
export interface SubjectVersionTriggers {
  on_issues?: boolean | null
  issue_types?: string | null
  on_issue_comment?: boolean | null
  issue_comment_types?: string | null
  on_release?: boolean | null
  release_types?: string | null
}

export type SubjectEventName = 'issues' | 'issue_comment' | 'release'

/**
 * Actions' defaults when a workflow names no `types:`.
 *
 * `issues` defaults to every activity type it has, which is a long list and
 * the reason a naive `on: issues` workflow fires on labelling as well as
 * opening. `release` defaults to *published only* in practice, because that is
 * what people mean, and Actions' own default of "all types" surprises everyone
 * who has ever had a draft release start a deployment.
 */
const DEFAULT_TYPES: Record<SubjectEventName, string[]> = {
  issues: ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled', 'assigned', 'unassigned'],
  issue_comment: ['created', 'edited', 'deleted'],
  release: ['published'],
}

export interface SubjectEvent {
  /** `opened`, `closed`, `created`, `published`, ... */
  activity: string
}

/** Should this issue, comment or release event start a run of this version? */
export function subjectStartsRun(
  version: SubjectVersionTriggers,
  event: SubjectEventName,
  activity: string,
): TriggerDecision {
  const wanted = event === 'issues'
    ? version.on_issues
    : event === 'issue_comment'
      ? version.on_issue_comment
      : version.on_release

  if (!wanted)
    return { run: false, reason: `the workflow does not trigger on ${event}` }

  const declared = patternsFrom(
    event === 'issues'
      ? version.issue_types
      : event === 'issue_comment'
        ? version.issue_comment_types
        : version.release_types,
  )

  const allowed = declared.length > 0 ? declared : DEFAULT_TYPES[event]

  if (!allowed.includes(activity))
    return { run: false, reason: `${event} ${activity} is not one of the activity types this workflow runs on` }

  return { run: true, reason: `${event} ${activity}` }
}

/**
 * `repository_dispatch`: a run started by a program.
 *
 * The filter is the `event_type` the caller sends, matched against `types:`.
 * A workflow that names none takes every one, which is Actions' rule.
 */
export interface RepositoryDispatchVersionTriggers {
  on_repository_dispatch?: boolean | null
  repository_dispatch_types?: string | null
}

export function repositoryDispatchStartsRun(
  version: RepositoryDispatchVersionTriggers,
  eventType: string,
): TriggerDecision {
  if (!version.on_repository_dispatch)
    return { run: false, reason: 'the workflow does not trigger on repository_dispatch' }

  const declared = patternsFrom(version.repository_dispatch_types)

  if (declared.length > 0 && !declared.includes(eventType))
    return { run: false, reason: `\`${eventType}\` is not one of the event types this workflow runs on` }

  return { run: true, reason: `repository_dispatch ${eventType}` }
}

/**
 * `workflow_run`: this workflow starts when another one finishes.
 *
 * Matched on the triggering workflow's **name**, because that is what Actions
 * matches and what the person writing the second workflow has read - they know
 * the first one is called `Build`, not that it lives at
 * `.github/workflows/build-and-cache.yml`.
 */
export interface WorkflowRunVersionTriggers {
  on_workflow_run?: boolean | null
  workflow_run_workflows?: string | null
  workflow_run_types?: string | null
  workflow_run_branches?: string | null
}

export interface TriggeringRun {
  /** The finished run's workflow name. */
  workflow: string
  /** `completed` or `requested`. */
  activity: string
  /** The finished run's ref, for `branches:`. */
  ref: string
}

/** Actions' default when a `workflow_run` names no types. */
const WORKFLOW_RUN_DEFAULT_TYPES = ['completed']

export function workflowRunStartsRun(
  version: WorkflowRunVersionTriggers,
  triggering: TriggeringRun,
): TriggerDecision {
  if (!version.on_workflow_run)
    return { run: false, reason: 'the workflow does not trigger on workflow_run' }

  const named = patternsFrom(version.workflow_run_workflows)

  /*
   * A `workflow_run` naming no workflows is refused rather than read as "any".
   *
   * Actions requires `workflows:`, and the reason is worth keeping: a workflow
   * that started after *every* other workflow in the repository would start
   * after itself, and the first thing anybody would notice is a loop.
   */
  if (named.length === 0)
    return { run: false, reason: 'this `workflow_run` names no workflows, so nothing can start it' }

  if (!named.includes(triggering.workflow))
    return { run: false, reason: `\`${triggering.workflow}\` is not one of the workflows this one waits for` }

  const types = patternsFrom(version.workflow_run_types)
  const allowed = types.length > 0 ? types : WORKFLOW_RUN_DEFAULT_TYPES

  if (!allowed.includes(triggering.activity))
    return { run: false, reason: `workflow_run ${triggering.activity} is not one of the activity types this workflow runs on` }

  const branches = patternsFrom(version.workflow_run_branches)

  if (branches.length > 0) {
    const name = triggering.ref.replace(/^refs\/heads\//, '')

    if (!branches.some(pattern => globMatches(pattern, name)))
      return { run: false, reason: `the run that finished was on \`${name}\`, which this workflow does not watch` }
  }

  return { run: true, reason: `workflow_run ${triggering.activity} of ${triggering.workflow}` }
}
