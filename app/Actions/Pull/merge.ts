/**
 * What has to be true before a pull request may merge, what the resulting
 * commit says, and what happens to the pull requests stacked on top of it.
 *
 * Merging is the one irreversible thing a forge does to somebody's branch, so
 * every reason to refuse is collected and returned together rather than the
 * first one found: a contributor who fixes the conflict only to be told they
 * also need an approval has been sent round the loop twice for no reason.
 *
 * Pure over plain objects. The action reads the rows and runs the git commands;
 * the rules live here where they can be tested.
 */

import { restrictionPermits } from '../Repo/branchRules'

export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const
export type MergeStrategy = typeof MERGE_STRATEGIES[number]

export function isMergeStrategy(value: string): value is MergeStrategy {
  return (MERGE_STRATEGIES as readonly string[]).includes(value)
}

/** A repository's merge settings, as the columns store them. */
export interface MergeSettings {
  allow_merge_commit?: unknown
  allow_squash_merge?: unknown
  allow_rebase_merge?: unknown
  default_merge_strategy?: unknown
}

/**
 * Which ways this repository lets a pull request land.
 *
 * A column per strategy rather than a parsed list, so there is no malformed
 * value to interpret - and therefore no way for a merge setting to fail open,
 * which is a branch rule quietly ceasing to apply.
 *
 * `undefined` reads as allowed. A row written before these columns existed has
 * nulls in them, and reading a null as "not allowed" would stop every merge in
 * every repository on the day the migration ran. The columns default to true
 * for new rows; this is the same answer for old ones.
 */
export function allowedStrategies(settings: MergeSettings | null | undefined): MergeStrategy[] {
  const allowed = (value: unknown): boolean => value !== false && value !== 0 && value !== '0' && value !== 'false'

  const strategies: MergeStrategy[] = []
  if (allowed(settings?.allow_merge_commit))
    strategies.push('merge')
  if (allowed(settings?.allow_squash_merge))
    strategies.push('squash')
  if (allowed(settings?.allow_rebase_merge))
    strategies.push('rebase')

  return strategies
}

/**
 * The strategy the merge control offers first.
 *
 * The configured default when it is one, and `merge` otherwise. Deliberately
 * *not* narrowed to what is allowed: a default that is not allowed is a
 * misconfiguration, and substituting a different strategy silently is how
 * somebody squashes a branch they meant to rebase. The merge action refuses it
 * like any other disallowed strategy, which is a message rather than a
 * surprise.
 */
export function defaultStrategy(settings: MergeSettings | null | undefined): MergeStrategy {
  const configured = String(settings?.default_merge_strategy ?? '')

  return isMergeStrategy(configured) ? configured : 'merge'
}

export interface MergeCandidate {
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  /** From git: whether the branches combine without conflict. */
  mergeable: boolean | null
  /** A pull request this one is stacked on, if any. */
  stackParent: { state: 'open' | 'closed' | 'merged' } | null
}

export interface MergeRules {
  requiredApprovals: number
  requireThreadsResolved: boolean
  requireLinearHistory: boolean
  allowedStrategies: readonly MergeStrategy[]
  /** Names of checks that must have reported success on the head commit. */
  requiredChecks?: readonly string[]
  /**
   * A change written by a machine account needs one human approval.
   *
   * Only meaningful when the author *is* one, which the readiness reports
   * rather than this: whether the rule applies and whether it is satisfied are
   * different questions, and a rule that had to know who the author was would
   * need the database.
   */
  requireHumanApprovalForAgents?: boolean
  /**
   * The base branch has to already be in the head before this may merge.
   *
   * GitHub's `required_status_checks.strict`, and the reason it lives beside
   * the checks rather than inside them: a check that passed on a head which
   * never contained the current tip of the base tested code that is about to
   * stop existing. Two branches that each pass alone and break together is what
   * this catches.
   */
  requireUpToDate?: boolean
  /**
   * Only these users and teams may write to the branch, or null for anybody
   * with push access.
   *
   * Enforced here as well as at the push gate because a merge writes to the
   * base branch exactly as a push does - and a restriction with a merge button
   * beside it is not a restriction.
   */
  restrictedTo?: { users: readonly string[], teams: readonly string[] } | null
  /**
   * Whether the rules above also bind somebody who administers the repository.
   *
   * `undefined` reads as **true**, matching the column's default and the
   * behaviour every rule had before the column existed: a caller that has not
   * been taught to load this must not thereby exempt every admin.
   *
   * Only the branch's own rules are ever waived. A conflict, a draft, an
   * unmerged parent and a strategy the repository does not allow are not
   * protections somebody is being held to - they are reasons the merge would
   * not mean what it says - so an administrator is refused for them like
   * anybody else.
   */
  enforceAdmins?: boolean
}

export interface MergeReadiness {
  approvals: number
  blockingReviews: number
  /**
   * Approvals that exist but do not count, because they came from a machine
   * account and the repository has not opted in.
   *
   * Reported so the refusal can say why. "1 more approval is required" on a
   * pull request showing an approval reads as a bug in the counting, and the
   * reader's next move is to ask somebody rather than to find the setting.
   */
  uncountedApprovals?: number
  /** Whether the pull request was written by a machine account. */
  authorIsMachine?: boolean
  /** Approvals from accounts that are not machines. */
  humanApprovals?: number
  unresolvedThreads: number
  /** From `requirementsSatisfied` in app/Actions/Checks/status.ts. */
  checks?: {
    failing: readonly string[]
    pending: readonly string[]
    missing: readonly string[]
  }
  /**
   * Whether the base branch has moved on since the head last took it.
   *
   * `null` means git has not been asked, and like `mergeable` that is still a
   * blocker rather than an assumption: merging on an unknown answer is how a
   * rule meant to stop untested combinations lets exactly one through.
   */
  behindBase?: boolean | null
  /** Who is pressing merge, for the two rules that turn on the answer. */
  actor?: { handle: string | null, isAdmin: boolean, teams: readonly string[] } | null
}

/**
 * Every reason this pull request may not merge right now.
 *
 * An empty array means it may. The strings are shown to the person clicking
 * merge, so they say what to do rather than what failed.
 */
export function mergeBlockers(
  pullRequest: MergeCandidate,
  rules: MergeRules,
  readiness: MergeReadiness,
  strategy: MergeStrategy,
): string[] {
  const blockers: string[] = []

  if (pullRequest.state === 'merged')
    return ['This pull request has already been merged']

  /*
   * Whether the branch's own rules apply to whoever is asking.
   *
   * False only when the rule was written with `enforce_admins` off *and* this
   * person administers the repository - which is to say, only when somebody
   * with the power to delete the rule outright has instead been given a way to
   * merge past it and leave a record.
   *
   * The reasons below that are not branch rules ignore this entirely. A
   * conflict is not a protection.
   */
  const bound = !(rules.enforceAdmins === false && readiness.actor?.isAdmin === true)

  if (pullRequest.state === 'closed')
    blockers.push('Reopen this pull request before merging it')

  if (pullRequest.draft)
    blockers.push('Mark this pull request ready for review before merging it')

  // Null means git has not been asked yet. Still a blocker, because merging on
  // an unknown answer is how a forge produces a conflicted merge commit, but it
  // says so rather than claiming a conflict it has not seen. Telling somebody
  // their branch conflicts when nothing has been checked sends them off to
  // rebase a branch that was fine.
  if (pullRequest.mergeable === false)
    blockers.push('This branch has conflicts that must be resolved')
  else if (pullRequest.mergeable === null)
    blockers.push('Whether this merges cleanly has not been checked yet')

  /*
   * Who may write to this branch at all, first among the branch rules.
   *
   * Before the approval and check counts on purpose: telling somebody they need
   * one more approval, when in fact no merge of theirs can land on this branch,
   * sends them off to collect a review that will not help.
   */
  if (bound && rules.restrictedTo) {
    const permitted = restrictionPermits(
      { users: [...rules.restrictedTo.users], teams: [...rules.restrictedTo.teams] },
      readiness.actor ?? null,
    )

    if (!permitted) {
      blockers.push(
        readiness.actor?.handle
          ? `This branch takes changes only from named users and teams, and ${readiness.actor.handle} is not one of them`
          : 'This branch takes changes only from named users and teams',
      )
    }
  }

  if (bound && readiness.blockingReviews > 0)
    blockers.push('Changes requested by a reviewer must be resolved')

  if (bound && readiness.approvals < rules.requiredApprovals) {
    const missing = rules.requiredApprovals - readiness.approvals
    const uncounted = readiness.uncountedApprovals ?? 0

    // The reason, when there is one. Without it the sentence contradicts the
    // approval sitting on the screen.
    const because = uncounted > 0
      ? ` (${uncounted} from a machine account ${uncounted === 1 ? 'does' : 'do'} not count toward this, which the repository can change)`
      : ''

    blockers.push(`${missing} more ${missing === 1 ? 'approval is' : 'approvals are'} required${because}`)
  }

  /*
   * A person has to have looked. Checked separately from the count, because
   * "two approvals" and "one of them from a human" are different requirements
   * and a repository that wanted only the second would otherwise have to set
   * the first as a proxy for it.
   */
  if (bound && rules.requireHumanApprovalForAgents && readiness.authorIsMachine && (readiness.humanApprovals ?? 0) < 1)
    blockers.push('This branch requires a person to approve a change written by a machine account')

  if (bound && rules.requireThreadsResolved && readiness.unresolvedThreads > 0) {
    blockers.push(
      `${readiness.unresolvedThreads} review ${readiness.unresolvedThreads === 1 ? 'thread' : 'threads'} must be resolved`,
    )
  }

  // A check nobody required never blocks; the caller decides which are
  // required, and this only reports what that decision produced.
  const checks = bound ? readiness.checks : null
  if (checks) {
    if (checks.failing.length > 0)
      blockers.push(`Required ${checks.failing.length === 1 ? 'check' : 'checks'} failed: ${checks.failing.join(', ')}`)

    if (checks.pending.length > 0)
      blockers.push(`Waiting for ${checks.pending.join(', ')}`)

    // Never reported is not the same as still running: one resolves itself and
    // the other means the workflow is not wired up.
    if (checks.missing.length > 0)
      blockers.push(`Waiting for ${checks.missing.join(', ')} to report for the first time`)
  }

  /*
   * Out of date with the base, which is what makes the checks above worth
   * anything.
   *
   * Immediately after them because that is the order the reader needs: a green
   * tick on a head that predates three merges to the base is a green tick for
   * code nobody is going to ship, and the sentence has to arrive while they are
   * still looking at the ticks.
   *
   * The unknown answer blocks, exactly as an unchecked mergeability does. A
   * rule whose whole purpose is to stop untested combinations landing would be
   * a strange one to skip the moment git failed to answer.
   */
  if (bound && rules.requireUpToDate) {
    if (readiness.behindBase === true)
      blockers.push('This branch is out of date with its base, so update it before merging')
    else if (readiness.behindBase === null || readiness.behindBase === undefined)
      blockers.push('Whether this branch is up to date with its base has not been checked yet')
  }

  if (!rules.allowedStrategies.includes(strategy))
    blockers.push(`The ${strategy} strategy is not allowed on this branch`)

  // A merge commit has two parents, which is exactly what a linear history
  // forbids. Squash and rebase both produce one.
  if (bound && rules.requireLinearHistory && strategy === 'merge')
    blockers.push('This branch requires a linear history, so use squash or rebase')

  // Merging a stacked pull request before its parent would take the parent's
  // commits along with it and leave the parent showing a diff of nothing.
  if (pullRequest.stackParent && pullRequest.stackParent.state !== 'merged')
    blockers.push('The pull request this one is stacked on must be merged first')

  return blockers
}

export interface MergeMessageInput {
  number: number
  title: string
  body: string
  headBranch: string
  baseBranch: string
  /** Commit subjects on the branch, oldest first. Used by squash. */
  commits: string[]
}

/**
 * The message for the commit a merge produces.
 *
 * The subject carries the pull request number, because six months later the
 * number is the only thread back to the discussion that produced the change.
 */
export function mergeCommitMessage(strategy: MergeStrategy, input: MergeMessageInput): { subject: string, body: string } {
  if (strategy === 'squash') {
    // The pull request title is the reviewed description of the whole change;
    // the individual commit subjects are the working notes underneath it.
    const notes = input.commits.map(commit => `* ${commit}`).join('\n')
    const body = [input.body.trim(), notes].filter(Boolean).join('\n\n')

    return { subject: `${input.title} (#${input.number})`, body }
  }

  if (strategy === 'rebase') {
    // Rebase replays the author's commits unchanged; there is no new commit to
    // write a message for.
    return { subject: '', body: '' }
  }

  return {
    subject: `Merge pull request #${input.number} from ${input.headBranch}`,
    body: input.title.trim(),
  }
}

export interface StackedChild {
  id: number
  baseBranch: string
  stackParentId: number | null
}

export interface MergedParent {
  id: number
  headBranch: string
  baseBranch: string
  stackParentId: number | null
}

export interface Retarget {
  id: number
  baseBranch: string
  stackParentId: number | null
}

/**
 * Where the pull requests stacked on a merged one should now point.
 *
 * This is the whole reason stacked pull requests are usable. A child was opened
 * against its parent's branch; once the parent merges, that branch is gone or
 * about to be, and a child still pointing at it shows a diff against a branch
 * nobody is updating. Each child moves down to whatever its parent was based
 * on, which is the branch its changes are actually going to.
 *
 * Only children pointing at the merged branch move. A child that was retargeted
 * by hand is left alone.
 */
export function retargetStack(parent: MergedParent, children: StackedChild[]): Retarget[] {
  const moves: Retarget[] = []

  for (const child of children) {
    if (child.stackParentId !== parent.id)
      continue

    if (child.baseBranch !== parent.headBranch) {
      // Someone has already pointed this one elsewhere. Drop the stack link so
      // it stops referring to a merged pull request, but leave the base alone.
      moves.push({ id: child.id, baseBranch: child.baseBranch, stackParentId: parent.stackParentId })
      continue
    }

    moves.push({ id: child.id, baseBranch: parent.baseBranch, stackParentId: parent.stackParentId })
  }

  return moves
}

/**
 * Whether the head branch may be deleted after a merge.
 *
 * Deleting a branch another open pull request is built on breaks that pull
 * request, and the contributor loses the branch they are still working from.
 */
export function mayDeleteHeadBranch(input: {
  deleteOnMerge: boolean
  headIsDefaultBranch: boolean
  headIsFork: boolean
  openPullRequestsOnHead: number
}): boolean {
  if (!input.deleteOnMerge)
    return false

  if (input.headIsDefaultBranch)
    return false

  // A fork's branch belongs to its owner.
  if (input.headIsFork)
    return false

  return input.openPullRequestsOnHead === 0
}
