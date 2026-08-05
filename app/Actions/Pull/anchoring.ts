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
  reviews: Array<{ reviewerId: number, state: string, commitSha: string | null }>
  headSha: string | null
  requiredApprovals: number
  dismissStaleReviews: boolean
}): { satisfied: boolean, approvals: number, blocking: number } {
  // Only the latest review from each reviewer counts; an approval after a
  // change request is a change of mind, not a second opinion.
  const latest = new Map<number, { state: string, commitSha: string | null }>()
  for (const review of input.reviews) {
    if (review.state === 'pending' || review.state === 'dismissed')
      continue
    latest.set(review.reviewerId, { state: review.state, commitSha: review.commitSha })
  }

  let approvals = 0
  let blocking = 0

  for (const review of latest.values()) {
    if (review.state === 'changes_requested') {
      blocking += 1
      continue
    }

    if (review.state !== 'approved')
      continue

    if (input.dismissStaleReviews && reviewIsStale(review.commitSha, input.headSha))
      continue

    approvals += 1
  }

  return {
    satisfied: blocking === 0 && approvals >= input.requiredApprovals,
    approvals,
    blocking,
  }
}
