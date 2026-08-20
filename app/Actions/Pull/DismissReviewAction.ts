import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { dismissReview, mayDismissReview } from './review-requests'
import { coerced } from '../inputs'

/**
 * Dismiss a submitted review, with a reason.
 *
 * The reason is required, not encouraged. Dismissing an approval or a request
 * for changes overrides somebody's judgement, and a recorded reason is the only
 * thing separating that from quietly deleting it. The review is kept in place
 * with its state changed rather than removed, so the thread it belongs to still
 * reads in order afterwards.
 *
 * The review that is dismissed stops counting toward a protected branch's
 * required approvals, which is the practical effect and the reason to be careful
 * about who may do it.
 */
export default new Action({
  name: 'DismissReview',
  description: 'Dismiss a submitted review with a reason',
  method: 'PUT',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    reason: { rule: schema.string() },
    review_id: { rule: coerced },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const reviewId = Number(request.get('review_id'))
    const review = await db
      .selectFrom('pull_request_reviews')
      .select(['id', 'state', 'reviewer_id'])
      .where('id', '=', reviewId)
      .where('pull_request_id', '=', Number(pullRequest.id))
      .executeTakeFirst()

    if (!review)
      return response.json({ error: 'No such review on this pull request' }, 404)

    const isReviewer = Number(review.reviewer_id) === user.id
    if (!mayDismissReview({ isReviewer, canDismiss: can('pull:dismiss-review') }))
      return response.json({ error: 'Forbidden' }, 403)

    const result = dismissReview({
      pullRequestState: pullRequest.state as 'open' | 'closed' | 'merged',
      reviewState: review.state as 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed',
      reason: String(request.get('reason') ?? ''),
    })

    if (!result.ok)
      return response.json({ error: result.error }, result.status)

    await db
      .updateTable('pull_request_reviews')
      .set({ state: 'dismissed', dismissed_reason: result.reason })
      .where('id', '=', Number(review.id))
      .execute()

    // Dismissing a review is a way of asking for another look, so the request it
    // answered is reopened rather than left showing as replied to.
    await db
      .updateTable('pull_request_reviewers')
      .set({ responded_at: null })
      .where('pull_request_id', '=', Number(pullRequest.id))
      .where('reviewer_type', '=', 'user')
      .where('reviewer_id', '=', Number(review.reviewer_id))
      .execute()

    return response.json({
      number,
      review_id: Number(review.id),
      state: 'dismissed',
      reason: result.reason,
    })
  },
})
