/**
 * Rebasing the layers above, after the layer below lands.
 *
 * Retargeting moves a child's *base* down; this moves its *branch*. Without
 * it, a child stacked on a squashed or rebased parent still carries the
 * parent's original commits, and its diff against the new base shows work
 * that already landed - the reviewer re-reads the parent inside the child.
 * Restacking replays the child's own commits - the range from the parent's
 * old head to the child's head, which excludes everything the parent already
 * landed - onto the merge result, and moves the child's branch there.
 *
 * The replay is pointed at the *base* branch on purpose: what is wanted from it
 * is the sha of the child's commits rebuilt on the base tip, and nothing else.
 * That sha is then written to the child's own ref, guarded by the child's old
 * head - somebody pushing to the child mid-restack wins, and the restack
 * refuses rather than discarding their push.
 *
 * It goes through `replayOnto`, which is where the reason lives: git 2.54 made
 * replay apply its ref update by default, and under that default pointing
 * `--advance` at the base branch moves `main` to the child's commits, with no
 * merge, no review and no guard.
 *
 * A replay that cannot apply - the child genuinely conflicts with what landed
 * - leaves the branch alone. That is today's behavior for every child, and a
 * conflict is the one case where a human has to decide what the change means
 * now; the child's diff keeps showing the parent's work until they do, which
 * is at least honest about there being something to resolve.
 */

import { replayOnto, runGit } from '../Git/git'

export interface RestackOutcome {
  pullRequestId: number
  branch: string
  outcome: 'rebased' | 'conflict' | 'branch-moved' | 'skipped'
  newHead?: string
}

export async function restackChild(options: {
  diskPath: string
  child: { id: number, headBranch: string, headSha: string }
  parentOldHead: string
  baseBranch: string
  env?: Record<string, string>
}): Promise<RestackOutcome> {
  const { diskPath, child, parentOldHead, baseBranch } = options
  const skip = (outcome: RestackOutcome['outcome']): RestackOutcome =>
    ({ pullRequestId: child.id, branch: child.headBranch, outcome })

  if (!child.headBranch || !child.headSha || !parentOldHead || !baseBranch)
    return skip('skipped')

  // The child's branch as it is on disk, not as the row remembers it. The row
  // is brought up to date by the push pipeline, but the pipeline may not have
  // run yet, and the guard below has to name what is really there.
  const tip = await runGit(diskPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${child.headBranch}`])
  if (!tip.ok)
    return skip('skipped')

  const currentHead = tip.stdout.trim()

  const replayed = await replayOnto(
    diskPath,
    `refs/heads/${baseBranch}`,
    `${parentOldHead}..${currentHead}`,
    options.env,
  )

  if (!replayed.ok || !replayed.sha)
    return skip('conflict')

  const newHead = replayed.sha

  const moved = await runGit(diskPath, ['update-ref', `refs/heads/${child.headBranch}`, newHead, currentHead])
  if (!moved.ok)
    return skip('branch-moved')

  return { pullRequestId: child.id, branch: child.headBranch, outcome: 'rebased', newHead }
}
