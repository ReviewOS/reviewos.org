/**
 * Stacks: ordering them, spotting when one has broken, and deciding how much
 * of one can land at once.
 *
 * The workflow this serves is the one Meta built Phabricator around and Google
 * calls chaining: break a large change into a chain of small dependent ones,
 * keep working on the next while the previous is in review, and land them in
 * order. The two things that make it usable rather than clever are that each
 * change shows only its own work, and that the tool keeps the chain honest
 * when part of it moves.
 *
 * That second one is where stacks usually fall over. A parent is amended and
 * its children are left pointing at commits nobody has any more; a parent is
 * closed and its children are, in the article's word, orphaned. Detecting that
 * is the difference between a stack and a pile of pull requests that happen to
 * be related.
 *
 * Pure over plain objects, because every interesting case is a shape of graph
 * and setting those up against a database is miserable.
 */

export type PullState = 'open' | 'closed' | 'merged'

export interface StackMember {
  id: number
  number: number
  title: string
  state: PullState
  headBranch: string
  baseBranch: string
  stackParentId: number | null
  draft: boolean
}

/**
 * The whole chain a pull request belongs to, bottom first.
 *
 * Bottom first because that is the order things land in, and because the
 * position in that order is what a reviewer needs to know first: "this is the
 * third of five" tells you more than any dependency diagram.
 */
export function buildStack(all: readonly StackMember[], memberId: number): StackMember[] {
  const byId = new Map(all.map(member => [member.id, member]))
  const start = byId.get(memberId)
  if (!start)
    return []

  // Walk down to the root, guarding against a cycle: a stack that refers to
  // itself would otherwise hang the page rendering it.
  const seen = new Set<number>([start.id])
  const below: StackMember[] = []
  let current = start

  while (current.stackParentId !== null) {
    const parent = byId.get(current.stackParentId)
    if (!parent || seen.has(parent.id))
      break

    seen.add(parent.id)
    below.unshift(parent)
    current = parent
  }

  // Then up. A tree branches, and following every branch would present a graph
  // as a line; the first child keeps the common case right and the rest are
  // reachable from their own pages.
  const above: StackMember[] = []
  let cursor = start

  for (;;) {
    const child = all.find(candidate => candidate.stackParentId === cursor.id && !seen.has(candidate.id))
    if (!child)
      break

    seen.add(child.id)
    above.push(child)
    cursor = child
  }

  return [...below, start, ...above]
}

/** Where this one sits, counting from one. */
export function positionIn(stack: readonly StackMember[], memberId: number): { position: number, total: number } {
  const index = stack.findIndex(member => member.id === memberId)

  return { position: index === -1 ? 0 : index + 1, total: stack.length }
}

export type OrphanReason = 'parent-closed' | 'parent-missing' | 'retargeted' | null

/**
 * Whether this pull request has come loose from the one it was built on.
 *
 * An orphan cannot merge in the ordinary way and, more importantly, its diff
 * is measured against something that is no longer going anywhere. Saying so is
 * the whole job: the fix is a human decision, but nobody can make it while the
 * interface still shows a healthy stack.
 */
export function orphanReason(member: StackMember, all: readonly StackMember[]): OrphanReason {
  if (member.stackParentId === null)
    return null

  const parent = all.find(candidate => candidate.id === member.stackParentId)

  if (!parent)
    return 'parent-missing'

  // Closed without merging: the work below this one is not going in, so this
  // one is measured against a branch nobody will land.
  if (parent.state === 'closed')
    return 'parent-closed'

  // A merged parent is not an orphan, it is a stack that has started landing;
  // the child should have been retargeted to the parent's base.
  if (parent.state === 'merged')
    return member.baseBranch === parent.headBranch ? 'retargeted' : null

  // Still open, but this one no longer sits on its branch.
  return member.baseBranch === parent.headBranch ? null : 'retargeted'
}

/** The sentence shown to somebody looking at a broken stack. */
export function orphanMessage(reason: OrphanReason): string | null {
  switch (reason) {
    case 'parent-closed':
      return 'The pull request below this one was closed without merging, so this one is measured against work that is not landing.'
    case 'parent-missing':
      return 'The pull request below this one no longer exists.'
    case 'retargeted':
      return 'This no longer sits on the branch of the pull request below it, so the stack has come apart.'
    default:
      return null
  }
}

export interface MemberReadiness {
  id: number
  /** From `mergeBlockers`, ignoring the stack rule itself. */
  blockers: readonly string[]
}

/**
 * How much of the stack can land right now, bottom first.
 *
 * Landing is contiguous from the bottom by definition: merging the third
 * without the second would take the second's commits along with it. So this
 * returns the longest run from the bottom whose members are all ready, which
 * is what a "merge the whole stack" action may actually do.
 */
export function landablePrefix(
  stack: readonly StackMember[],
  readiness: readonly MemberReadiness[],
): StackMember[] {
  const byId = new Map(readiness.map(entry => [entry.id, entry]))
  const landable: StackMember[] = []

  for (const member of stack) {
    if (member.state === 'merged')
      continue

    if (member.state !== 'open' || member.draft)
      break

    const entry = byId.get(member.id)
    if (!entry || entry.blockers.length > 0)
      break

    landable.push(member)
  }

  return landable
}

/**
 * The member below this one that is holding it up, if any.
 *
 * A reviewer looking at the top of a stack wants to know which one to chase,
 * not that "something below is not ready".
 */
export function blockedBy(
  stack: readonly StackMember[],
  memberId: number,
  readiness: readonly MemberReadiness[],
): StackMember | null {
  const byId = new Map(readiness.map(entry => [entry.id, entry]))
  const index = stack.findIndex(member => member.id === memberId)
  if (index <= 0)
    return null

  for (let below = 0; below < index; below += 1) {
    const member = stack[below]!
    if (member.state === 'merged')
      continue

    if (member.state !== 'open' || member.draft)
      return member

    const entry = byId.get(member.id)
    if (!entry || entry.blockers.length > 0)
      return member
  }

  return null
}

/** A one-line summary for the stack panel. */
export function stackSummary(stack: readonly StackMember[]): string {
  if (stack.length <= 1)
    return 'Not part of a stack'

  const merged = stack.filter(member => member.state === 'merged').length

  return merged === 0
    ? `${stack.length} pull requests in this stack`
    : `${merged} of ${stack.length} in this stack have merged`
}

/**
 * Everything that lands when somebody merges one member of a stack.
 *
 * The instinct is to refuse: the third cannot merge before the second. But
 * refusing is the wrong end of the stick, because merging the third *does*
 * take the second's commits with it, so the honest thing is to land both and
 * say so. GitHub's stacked pull requests settled on the same answer in their
 * public preview: merging a layer lands it and every unmerged layer below it.
 *
 * Returns bottom first, so the caller merges in order. Empty when anything
 * below is not ready, because landing a change whose parent is still being
 * argued about is the one thing a stack must never do quietly.
 */
export function landableThrough(
  stack: readonly StackMember[],
  memberId: number,
  readiness: readonly MemberReadiness[],
): StackMember[] {
  const byId = new Map(readiness.map(entry => [entry.id, entry]))
  const index = stack.findIndex(member => member.id === memberId)
  if (index === -1)
    return []

  const run: StackMember[] = []

  for (let position = 0; position <= index; position += 1) {
    const member = stack[position]!

    // Already landed: it is not merged again, and it does not block.
    if (member.state === 'merged')
      continue

    if (member.state !== 'open' || member.draft)
      return []

    const entry = byId.get(member.id)
    if (!entry || entry.blockers.length > 0)
      return []

    run.push(member)
  }

  return run
}
