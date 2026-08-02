/**
 * Issue state transitions.
 *
 * Two states and a reason sounds too small to be worth its own module, until
 * you count the places that close an issue: the close button, a closing keyword
 * in a commit message, a merged pull request, and the API. Each of them has to
 * agree about what a close does, and about what happens when the issue is
 * already closed, or locked.
 *
 * Pure, so the rules can be tested without a repository or a database.
 */

export type IssueState = 'open' | 'closed'

/** Why an issue was closed. `completed` is the default a plain close means. */
export const CLOSE_REASONS = ['completed', 'not_planned', 'duplicate'] as const
export type CloseReason = typeof CLOSE_REASONS[number]

export type IssueTransition = 'close' | 'reopen'

export interface IssueStateInput {
  state: IssueState
  locked: boolean
}

export type TransitionOutcome =
  | { ok: true, state: IssueState, reason: CloseReason | null }
  | { ok: false, error: string, status: number }

/**
 * Apply a transition to an issue.
 *
 * Closing an already closed issue is not an error but does nothing, so a commit
 * message that repeats `fixes #12` across a rebase does not rewrite the record
 * of who closed it and when. Reopening a closed issue clears the reason: an
 * issue that is open was not closed for any reason.
 */
export function transitionIssue(
  issue: IssueStateInput,
  transition: IssueTransition,
  reason: string | null = null,
): TransitionOutcome {
  if (issue.locked)
    return { ok: false, error: 'This issue is locked', status: 423 }

  if (transition === 'close') {
    if (issue.state === 'closed')
      return { ok: true, state: 'closed', reason: normalizeCloseReason(reason) }

    const normalized = normalizeCloseReason(reason)
    if (reason !== null && normalized === null)
      return { ok: false, error: 'Unknown close reason', status: 422 }

    return { ok: true, state: 'closed', reason: normalized ?? 'completed' }
  }

  return { ok: true, state: 'open', reason: null }
}

/** A close reason, or null when the value is absent or not one we recognise. */
export function normalizeCloseReason(reason: string | null | undefined): CloseReason | null {
  if (!reason)
    return null

  const lowered = reason.toLowerCase()

  return (CLOSE_REASONS as readonly string[]).includes(lowered) ? lowered as CloseReason : null
}

/**
 * How a state reads to somebody looking at the issue.
 *
 * The reason is part of the answer, not a detail behind it. "Closed as not
 * planned" and "Closed" are different outcomes for whoever opened the issue,
 * and a list that renders both as "Closed" is hiding the one fact they came
 * back to check.
 */
export function issueStateLabel(state: string, reason: string | null | undefined): string {
  if (state !== 'closed')
    return 'Open'

  switch (normalizeCloseReason(reason)) {
    case 'not_planned': return 'Closed as not planned'
    case 'duplicate': return 'Closed as duplicate'
    default: return 'Closed'
  }
}

/**
 * The pill variant for a state.
 *
 * A close that was not a completion is not a success, so it does not get the
 * colour that means one. The layout has a `draft` pill that is exactly the
 * neutral grey this needs.
 */
export function issueStatePill(state: string, reason: string | null | undefined): string {
  if (state !== 'closed')
    return 'open'

  return normalizeCloseReason(reason) === 'completed' || !reason ? 'closed' : 'draft'
}

/**
 * Whether a comment may be added.
 *
 * Locking an issue is how a maintainer ends a thread that has stopped being
 * useful, so it has to hold against everyone who is not maintaining the
 * repository. Maintainers keep the ability to add a closing note.
 */
export function mayComment(input: { locked: boolean, isMaintainer: boolean }): boolean {
  return !input.locked || input.isMaintainer
}
