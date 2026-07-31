/**
 * Asking for a review, and taking a verdict back.
 *
 * These are two halves of the same question: whose opinion is currently being
 * counted on this pull request. A request adds someone to that set, a dismissal
 * removes a verdict from it, and a protected branch reads the result. Getting
 * either wrong shows a merge box that disagrees with what the merge will do.
 *
 * Pure, so the rules can be tested without a repository or a database.
 */

export type ReviewState = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed'

export interface RequestInput {
  /** The pull request's state. Only an open one can gain reviewers. */
  pullRequestState: 'open' | 'closed' | 'merged'
  /** Who is being asked. */
  reviewerId: number
  reviewerType: 'user' | 'team'
  /** The pull request's author, who cannot be asked to review their own work. */
  authorId: number
  /** Set when this reviewer has already been asked and has not yet replied. */
  alreadyPending: boolean
  /** Set when this reviewer was asked before and answered. */
  answeredPreviously: boolean
}

export type RequestOutcome =
  | { ok: true, action: 'created' | 'unchanged' | 're-requested' }
  | { ok: false, error: string, status: number }

/**
 * Whether a review request can be made, and what it should do.
 *
 * Asking again after someone has already replied is the useful case, not an
 * error: it is how an author says "I have addressed your comments, please look
 * again", and it is the reason the request row is kept rather than deleted when
 * a review is submitted.
 */
export function requestReview(input: RequestInput): RequestOutcome {
  if (input.pullRequestState !== 'open')
    return { ok: false, error: 'Only an open pull request can request a review', status: 409 }

  if (input.reviewerType === 'user' && input.reviewerId === input.authorId)
    return { ok: false, error: 'The author of a pull request cannot review it', status: 422 }

  if (input.alreadyPending)
    return { ok: true, action: 'unchanged' }

  return { ok: true, action: input.answeredPreviously ? 're-requested' : 'created' }
}

/** Who may ask for a review: the author, or anyone who can triage. */
export function mayRequestReview(input: { isAuthor: boolean, canRequest: boolean }): boolean {
  return input.isAuthor || input.canRequest
}

export interface DismissInput {
  pullRequestState: 'open' | 'closed' | 'merged'
  reviewState: ReviewState
  reason: string
}

export type DismissOutcome =
  | { ok: true, reason: string }
  | { ok: false, error: string, status: number }

/**
 * Whether a submitted review can be dismissed.
 *
 * A reason is required rather than encouraged. Dismissing an approval or a
 * change request overrides somebody's judgement, and the record of why is the
 * only thing that separates that from silently deleting it. Only the two states
 * that carry a verdict can be dismissed: a plain comment is not blocking
 * anything, so there is nothing to take back.
 */
export function dismissReview(input: DismissInput): DismissOutcome {
  if (input.pullRequestState === 'merged')
    return { ok: false, error: 'This pull request has been merged, so its reviews stand', status: 409 }

  if (input.reviewState === 'dismissed')
    return { ok: false, error: 'That review has already been dismissed', status: 409 }

  if (input.reviewState !== 'approved' && input.reviewState !== 'changes_requested') {
    return {
      ok: false,
      error: 'Only an approval or a request for changes can be dismissed',
      status: 422,
    }
  }

  const reason = input.reason.trim()
  if (!reason)
    return { ok: false, error: 'Dismissing a review needs a reason', status: 422 }

  return { ok: true, reason }
}

/**
 * Who may dismiss a review.
 *
 * A reviewer may take back their own verdict, which is not an override of
 * anyone. Overriding somebody else's takes write access.
 */
export function mayDismissReview(input: { isReviewer: boolean, canDismiss: boolean }): boolean {
  return input.isReviewer || input.canDismiss
}
