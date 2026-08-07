import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

const STATES = ['approved', 'changes_requested', 'commented'] as const

/**
 * Submit a review.
 *
 * A review is recorded against the commit it was written about, not against the
 * pull request in general. That single field is what makes "this approval is
 * stale" answerable after a force push, and what a protected branch consults
 * when it dismisses stale reviews.
 *
 * Pending threads written during the review are published in the same request,
 * so a reviewer's comments appear together rather than trickling out as they
 * type them.
 */
export default new Action({
  name: 'SubmitReview',
  description: 'Submit a review on a pull request',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:review')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const state = String(request.get('state') ?? 'commented')
    if (!(STATES as readonly string[]).includes(state))
      return response.json({ error: 'Unknown review state' }, 422)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'author_id', 'head_sha', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    if (pullRequest.state !== 'open')
      return response.json({ error: 'This pull request is no longer open' }, 409)

    // Approving your own work defeats the point of requiring an approval.
    // Commenting on it does not, so only the two deciding states are refused.
    if (Number(pullRequest.author_id) === user.id && state !== 'commented')
      return response.json({ error: 'You cannot approve or request changes on your own pull request' }, 422)

    const body = String(request.get('body') ?? '').trim()
    if (state === 'commented' && !body)
      return response.json({ error: 'A comment review needs a body' }, 422)

    const created = await db
      .insertInto('pull_request_reviews')
      .values({
        pull_request_id: Number(pullRequest.id),
        reviewer_id: user.id,
        state,
        body,
        commit_sha: pullRequest.head_sha,
        submitted_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    const reviewId = Number(created?.id)

    // A requested review is answered by submitting one.
    await db
      .updateTable('pull_request_reviewers')
      .set({ responded_at: new Date().toISOString() })
      .where('pull_request_id', '=', Number(pullRequest.id))
      .where('reviewer_id', '=', user.id)
      .execute()

    // An approval may be the last requirement. attemptAutoMerge never throws
    // and does nothing unless somebody armed it.
    const { attemptAutoMerge } = await import('./autoMerge')
    await attemptAutoMerge(Number(pullRequest.id))

    return response.json({
      id: reviewId,
      state,
      commit_sha: pullRequest.head_sha,
    }, 201)
  },
})
