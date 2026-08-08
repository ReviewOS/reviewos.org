/**
 * Keeping a review thread pointed at the line it was written about.
 *
 * This is the part reviewers notice when it is wrong. A thread was written
 * against one commit; the branch then gains commits, or is rebased, or is force
 * pushed. The line it refers to may have moved, may be unchanged, or may be
 * gone.
 *
 * The rule: follow the line through the diff between the commit the thread was
 * written against and the current head. If it survives, move the thread. If it
 * does not, mark the thread outdated and keep it readable, because a
 * conversation about code that has since changed is still the record of why the
 * code changed.
 *
 * A thread is never deleted here. Losing review history to a rebase is the
 * failure this whole module exists to prevent.
 */

import type { DiffFile } from './diff'

export interface Anchor {
  path: string
  line: number
  side: 'left' | 'right'
}

export type AnchorOutcome =
  | { status: 'moved', anchor: Anchor }
  | { status: 'unchanged', anchor: Anchor }
  | { status: 'outdated', anchor: Anchor }

/**
 * Where a line on the right-hand side of an old diff sits in the new one.
 *
 * `files` is the diff from the commit the thread was written against to the
 * current head. A file absent from that diff did not change, so the line is
 * where it was.
 */
/**
 * Where a thread sits in the diff currently being shown.
 *
 * Not the same operation as `reanchor`, and confusing the two cost every review
 * comment on new code its place. `reanchor` maps a line **from the old side of
 * a diff to the new side**, which is what tracking a thread from the commit it
 * was written against to the current head requires. This is the diff from the
 * base to the head - the one on screen - and a thread's line is already a
 * position in it: a right-side line is a line of the head, a left-side line is
 * a line of the base. Neither needs mapping, and mapping a right-side line as
 * though it were an old-side one lands on whatever happens to occupy that
 * number in the base.
 *
 * What that did: a thread on an added line was reported **outdated the moment
 * it was created**, because the old side of the diff has nothing at that
 * number - the line is new. Commenting on the code being proposed is the most
 * ordinary thing a reviewer does, and every one of those comments rendered as a
 * relic of some earlier version that never existed.
 *
 * So a thread is outdated here only when there is genuinely nowhere to put it:
 * the file was deleted, or it is binary. A line the author has since removed is
 * *shown* in this diff, on the left, which is exactly where the comment about
 * it belongs.
 *
 * Outdatedness that comes from the head *moving* is a different question, and
 * one this function is not given enough to answer - see `reanchor`, and the
 * roadmap item about tracking through intervening diffs.
 */
export function placeThread(anchor: Anchor, files: readonly DiffFile[]): AnchorOutcome {
  const file = files.find(candidate => candidate.path === anchor.path || candidate.previousPath === anchor.path)

  // Not in this diff, so this file did not change between base and head. The
  // thread is on a line nobody touched and stays exactly where it is.
  if (!file)
    return { status: 'unchanged', anchor }

  if (file.status === 'deleted')
    return { status: 'outdated', anchor }

  const path = file.previousPath === anchor.path ? file.path : anchor.path

  // Nothing to sit on. A comment on a line of a binary file has no line.
  if (file.binary)
    return { status: 'outdated', anchor: { ...anchor, path } }

  return path === anchor.path
    ? { status: 'unchanged', anchor }
    : { status: 'moved', anchor: { ...anchor, path } }
}

export function reanchor(anchor: Anchor, files: readonly DiffFile[]): AnchorOutcome {
  const file = files.find(candidate => candidate.path === anchor.path || candidate.previousPath === anchor.path)

  // Untouched between the two commits: nothing to do.
  if (!file)
    return { status: 'unchanged', anchor }

  if (file.status === 'deleted')
    return { status: 'outdated', anchor }

  // A rename with no content change moves every line, path and all.
  const path = file.previousPath === anchor.path ? file.path : anchor.path

  if (file.binary)
    return { status: 'outdated', anchor: { ...anchor, path } }

  const mapped = mapLine(anchor.line, file)

  if (mapped === null)
    return { status: 'outdated', anchor: { ...anchor, path } }

  if (mapped === anchor.line && path === anchor.path)
    return { status: 'unchanged', anchor: { ...anchor, path, line: mapped } }

  return { status: 'moved', anchor: { ...anchor, path, line: mapped } }
}

/**
 * Track one line number from the old side of a diff to the new side.
 *
 * Returns null when the line was removed. Lines before the first hunk, between
 * hunks, and after the last one are shifted by the running offset, which is how
 * a comment near the bottom of a file survives an edit near the top.
 */
export function mapLine(line: number, file: DiffFile): number | null {
  let offset = 0

  for (const hunk of file.hunks) {
    // Entirely before this hunk: only the accumulated offset applies.
    if (line < hunk.oldStart)
      return line + offset

    const hunkEnd = hunk.oldStart + hunk.oldLines - 1

    if (line <= hunkEnd) {
      // Inside the hunk: walk it, since only the diff itself knows whether this
      // particular line survived.
      for (const entry of hunk.lines) {
        if (entry.origin === 'removed' && entry.oldLine === line)
          return null
        if (entry.origin === 'context' && entry.oldLine === line)
          return entry.newLine
      }

      // A line inside the hunk's old range that the hunk never listed should
      // not happen, and guessing would put a comment on the wrong line.
      return null
    }

    offset += (hunk.newLines - hunk.oldLines)
  }

  return line + offset
}

/**
 * Whether an approval still speaks for the current head.
 *
 * An approval is of a specific commit. Once the branch moves, the reviewer has
 * not seen what is there now, and a protected branch that dismisses stale
 * reviews uses exactly this.
 */
export function reviewIsStale(reviewCommitSha: string | null, headSha: string | null): boolean {
  if (!reviewCommitSha || !headSha)
    return true

  return reviewCommitSha !== headSha
}

/**
 * Whether a pull request has the approvals a branch rule demands.
 *
 * A changes-requested review blocks regardless of the count: one reviewer
 * saying "not like this" is not outvoted by two saying "fine".
 */
export function approvalsSatisfied(input: {
  reviews: Array<{ reviewerId: number, state: string, commitSha: string | null, machine?: boolean }>
  headSha: string | null
  requiredApprovals: number
  dismissStaleReviews: boolean
  /**
   * Whether an approval from a machine account counts toward the total.
   *
   * Defaults to false, per the repository setting of the same name. The
   * failure mode is a branch protected by a robot approving its own class of
   * change - an agent opens it, an agent approves it, the rule is satisfied
   * and nobody looked.
   */
  countMachineApprovals?: boolean
}): { satisfied: boolean, approvals: number, blocking: number, uncounted: number, human: number } {
  // Only the latest review from each reviewer counts; an approval after a
  // change request is a change of mind, not a second opinion.
  const latest = new Map<number, { state: string, commitSha: string | null, machine: boolean }>()
  for (const review of input.reviews) {
    if (review.state === 'pending' || review.state === 'dismissed')
      continue
    latest.set(review.reviewerId, {
      state: review.state,
      commitSha: review.commitSha,
      machine: Boolean(review.machine),
    })
  }

  let approvals = 0
  let blocking = 0
  let uncounted = 0
  // Counted whether or not machine approvals count toward the total, because
  // the two rules are independent: a branch can require a human approval on an
  // agent's change while also counting an agent's approval on everyone else's.
  let human = 0

  for (const review of latest.values()) {
    if (review.state === 'changes_requested') {
      /*
       * A machine's objection blocks like anyone else's.
       *
       * The two directions are deliberately not symmetric: declining to count
       * a robot's approval is cautious, and ignoring a robot's objection is
       * the opposite. A repository that has opted out of machine approvals has
       * said it does not want a robot's "yes" to be the reason something
       * merged, not that it wants a robot's "no" thrown away.
       */
      blocking += 1
      continue
    }

    if (review.state !== 'approved')
      continue

    if (input.dismissStaleReviews && reviewIsStale(review.commitSha, input.headSha))
      continue

    if (!review.machine)
      human += 1

    if (review.machine && !input.countMachineApprovals) {
      // Counted separately rather than silently dropped, so the merge screen
      // can say "approved by a machine account, which this repository does not
      // count" instead of showing an approval and a refusal side by side with
      // nothing connecting them.
      uncounted += 1
      continue
    }

    approvals += 1
  }

  return {
    satisfied: blocking === 0 && approvals >= input.requiredApprovals,
    approvals,
    blocking,
    uncounted,
    human,
  }
}

/**
 * Which of these user ids are machine accounts.
 *
 * One query for the set rather than a lookup per review: a pull request with
 * eight reviews would otherwise make eight round trips to answer a question
 * about eight rows.
 *
 * A reviewer id that no longer exists is simply absent from the set, so a
 * deleted account's approval is treated as a person's. That is the safe
 * direction of the two - the alternative is a deletion quietly invalidating
 * approvals that were counted when the merge screen was drawn.
 */
export async function machineAccountsAmong(ids: number[]): Promise<Set<number>> {
  const wanted = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))]
  if (wanted.length === 0)
    return new Set()

  /*
   * `whereNotNull`, not `where(column, 'is not', null)`.
   *
   * The second binds the null as a parameter and emits
   * `"machine_for_organization_id" is not $2`, which Postgres answers with
   * `syntax error at or near "$2"`. Same defect `suggest.ts` documents at
   * length for the `is` half. Here it would have been worse than loud: the
   * caller treats a failure as "no machines", so every agent approval would
   * have counted.
   */
  const rows: any[] = await (globalThis as any).db
    .selectFrom('users')
    .select(['id'])
    .where('id', 'in', wanted)
    .whereNotNull('machine_for_organization_id')
    .execute()

  return new Set(rows.map(row => Number(row.id)))
}
