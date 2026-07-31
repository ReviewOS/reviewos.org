// Asking for a review, and taking a verdict back.
//
// Both sides decide whose opinion currently counts on a pull request, which is
// what a protected branch reads before it lets a merge through. The cases that
// matter are the ones where the answer changes without anybody submitting
// anything new: a re-request, and a dismissal.

import { describe, expect, test } from 'bun:test'
import {
  dismissReview,
  mayDismissReview,
  mayRequestReview,
  requestReview,
} from '../../app/Actions/Pull/review-requests'

const base = {
  pullRequestState: 'open' as const,
  reviewerId: 2,
  reviewerType: 'user' as const,
  authorId: 1,
  alreadyPending: false,
  answeredPreviously: false,
}

describe('requestReview', () => {
  test('asking someone new creates the request', () => {
    expect(requestReview(base)).toEqual({ ok: true, action: 'created' })
  })

  test('asking again before they reply changes nothing', () => {
    expect(requestReview({ ...base, alreadyPending: true })).toEqual({ ok: true, action: 'unchanged' })
  })

  test('asking again after they replied re-requests', () => {
    // This is how an author says the comments have been addressed, and the
    // reason the request row survives a submitted review.
    expect(requestReview({ ...base, answeredPreviously: true })).toEqual({ ok: true, action: 're-requested' })
  })

  test('the author cannot be asked to review their own pull request', () => {
    const result = requestReview({ ...base, reviewerId: 1 })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('a team sharing an id with the author is still a valid reviewer', () => {
    // Ids are only unique within a table, so the author check has to be about
    // users and not about the number.
    expect(requestReview({ ...base, reviewerType: 'team', reviewerId: 1 }).ok).toBe(true)
  })

  test('a closed pull request cannot gain reviewers', () => {
    const result = requestReview({ ...base, pullRequestState: 'closed' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('a merged pull request cannot gain reviewers', () => {
    expect(requestReview({ ...base, pullRequestState: 'merged' }).ok).toBe(false)
  })

  test('the author may ask without triage rights', () => {
    expect(mayRequestReview({ isAuthor: true, canRequest: false })).toBe(true)
    expect(mayRequestReview({ isAuthor: false, canRequest: false })).toBe(false)
  })
})

describe('dismissReview', () => {
  const dismissible = {
    pullRequestState: 'open' as const,
    reviewState: 'approved' as const,
    reason: 'The commits this approved were force-pushed away',
  }

  test('an approval can be dismissed with a reason', () => {
    expect(dismissReview(dismissible)).toEqual({
      ok: true,
      reason: 'The commits this approved were force-pushed away',
    })
  })

  test('a request for changes can be dismissed', () => {
    expect(dismissReview({ ...dismissible, reviewState: 'changes_requested' }).ok).toBe(true)
  })

  test('a reason is required', () => {
    const result = dismissReview({ ...dismissible, reason: '   ' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('a plain comment has no verdict to take back', () => {
    const result = dismissReview({ ...dismissible, reviewState: 'commented' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('a pending review has not been submitted yet', () => {
    expect(dismissReview({ ...dismissible, reviewState: 'pending' }).ok).toBe(false)
  })

  test('dismissing twice is refused rather than silently repeated', () => {
    const result = dismissReview({ ...dismissible, reviewState: 'dismissed' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('the reviews on a merged pull request stand', () => {
    // The merge already happened on the strength of them.
    const result = dismissReview({ ...dismissible, pullRequestState: 'merged' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('a reviewer may withdraw their own verdict; overriding another takes write', () => {
    expect(mayDismissReview({ isReviewer: true, canDismiss: false })).toBe(true)
    expect(mayDismissReview({ isReviewer: false, canDismiss: true })).toBe(true)
    expect(mayDismissReview({ isReviewer: false, canDismiss: false })).toBe(false)
  })
})
