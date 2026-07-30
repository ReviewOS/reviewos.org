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

export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const
export type MergeStrategy = typeof MERGE_STRATEGIES[number]

export function isMergeStrategy(value: string): value is MergeStrategy {
  return (MERGE_STRATEGIES as readonly string[]).includes(value)
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
}

export interface MergeReadiness {
  approvals: number
  blockingReviews: number
  unresolvedThreads: number
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

  if (pullRequest.state === 'closed')
    blockers.push('Reopen this pull request before merging it')

  if (pullRequest.draft)
    blockers.push('Mark this pull request ready for review before merging it')

  // Null means git has not been asked yet. Treated as a blocker: merging on an
  // unknown answer is how a forge produces a conflicted merge commit.
  if (pullRequest.mergeable !== true)
    blockers.push('This branch has conflicts that must be resolved')

  if (readiness.blockingReviews > 0)
    blockers.push('Changes requested by a reviewer must be resolved')

  if (readiness.approvals < rules.requiredApprovals) {
    const missing = rules.requiredApprovals - readiness.approvals
    blockers.push(`${missing} more ${missing === 1 ? 'approval is' : 'approvals are'} required`)
  }

  if (rules.requireThreadsResolved && readiness.unresolvedThreads > 0) {
    blockers.push(
      `${readiness.unresolvedThreads} review ${readiness.unresolvedThreads === 1 ? 'thread' : 'threads'} must be resolved`,
    )
  }

  if (!rules.allowedStrategies.includes(strategy))
    blockers.push(`The ${strategy} strategy is not allowed on this branch`)

  // A merge commit has two parents, which is exactly what a linear history
  // forbids. Squash and rebase both produce one.
  if (rules.requireLinearHistory && strategy === 'merge')
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
