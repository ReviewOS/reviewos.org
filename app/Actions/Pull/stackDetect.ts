/**
 * Noticing a stack in a push, before any pull request exists.
 *
 * Detection at open time fills `stack_parent_id` when a pull request targets
 * another one's branch; this is the half that meets somebody who pushed three
 * branches in a row and is about to open three pull requests in whatever
 * order they think of them. The push is the one moment the forge can see the
 * topology and the pusher is guaranteed to be looking - git relays whatever
 * the hook prints - so the offer goes there, as sentences.
 *
 * An offer, never an action. Opening pull requests uninvited would be the
 * suggestion-versus-request line crossed with a whole workflow: the pusher
 * may be about to push a fixup, or the branches may be an accident of
 * housekeeping. The forge says what it noticed and where to act on it.
 */

import { runGit } from '../Git/git'
import { isAncestor } from '../Mirror/fetch'
import type { RefUpdate } from '../Git/push'

/** More than this and the push is an import, not a workflow to comment on. */
const OFFER_LIMIT = 5

export async function stackOffersForPush(options: {
  gitDir: string
  ownerHandle: string
  repositoryName: string
  defaultBranch: string
  updates: readonly RefUpdate[]
  /** Open pull requests, head branch to head sha. */
  openHeads: ReadonlyMap<string, string>
}): Promise<string[]> {
  const { gitDir, ownerHandle, repositoryName, defaultBranch, updates, openHeads } = options

  const pushed = updates.filter(update =>
    update.kind === 'branch'
    && update.change !== 'deleted'
    && update.name !== defaultBranch)

  if (pushed.length === 0 || pushed.length > OFFER_LIMIT * 4)
    return []

  const offers: string[] = []

  for (const update of pushed) {
    if (offers.length >= OFFER_LIMIT * 2)
      break

    // A branch that already has an open pull request has already chosen its
    // base; open-time detection covered it, and re-suggesting is nagging.
    if (openHeads.has(update.name))
      continue

    // Candidate parents: every open pull request's head, and every branch in
    // this same push, whose tip this branch is built on. The nearest one -
    // fewest commits between the tips - is the parent; anything further is a
    // grandparent, and naming it would flatten the stack it describes.
    const candidates: Array<{ branch: string, sha: string, distance: number }> = []

    const consider = async (branch: string, sha: string): Promise<void> => {
      if (branch === update.name || !sha)
        return

      if (!(await isAncestor(gitDir, sha, update.after)))
        return

      const counted = await runGit(gitDir, ['rev-list', '--count', `${sha}..${update.after}`])
      const distance = Number(counted.stdout.trim())

      // Zero commits apart is the same tip: two names for one branch, which
      // is not a stack.
      if (counted.ok && Number.isFinite(distance) && distance > 0)
        candidates.push({ branch, sha, distance })
    }

    for (const [branch, sha] of openHeads)
      await consider(branch, sha)

    for (const sibling of pushed)
      await consider(sibling.name, sibling.after)

    if (candidates.length === 0)
      continue

    candidates.sort((a, b) => a.distance - b.distance)
    const parent = candidates[0]!

    offers.push(
      `branch '${update.name}' looks stacked on '${parent.branch}'`,
      `  open it as a stacked pull request: /${ownerHandle}/${repositoryName}/compare/${parent.branch}...${update.name}`,
    )
  }

  return offers
}
