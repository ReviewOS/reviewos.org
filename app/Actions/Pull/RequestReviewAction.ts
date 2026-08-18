import type { GitRepositoryRow } from '../Git/access'
import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { canOnRepository } from '../../Permissions'
import { permissionOn } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { mayRequestReview, requestReview } from './review-requests'

/**
 * Ask a user or a team for a review.
 *
 * Re-requesting from someone who already reviewed is the useful case rather than
 * an error: it is how an author says the comments have been addressed. The
 * request row is kept when a review is submitted precisely so this can clear
 * `responded_at` and ask again without losing the record of the first ask.
 */
export default new Action({
  name: 'RequestReview',
  description: 'Request a review from a user or a team',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. Read against the handler rather than the field name:
   * a declared rule is enforced, so a wrong one turns an ordinary request into
   * a 422 - which is how `assignees: string` broke assigning somebody.
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    number: { rule: schema.number().required() },
    reviewer_id: { rule: schema.number().required() },
    reviewer_type: { rule: schema.enum(['user', 'team']) },
  },

  responses: {
    201: { description: 'The request. Asking twice is not an error and does not ask twice.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Requesting a review needs access to the repository.' },
    422: { description: 'A reviewer is a user or a team, and has to be one that exists.' },
    404: { description: 'No such repository or pull request, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const reviewerType = String(request.get('reviewer_type') ?? 'user')
    if (reviewerType !== 'user' && reviewerType !== 'team')
      return response.json({ error: 'A reviewer is a user or a team' }, 422)

    const reviewerId = Number(request.get('reviewer_id'))
    if (!Number.isInteger(reviewerId) || reviewerId <= 0)
      return response.json({ error: 'A reviewer is required' }, 422)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      // `title` among them: the notification below reads it, and selecting
      // without it made every review request arrive with an empty title.
      .select(['id', 'state', 'author_id', 'title'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const isAuthor = Number(pullRequest.author_id) === user.id
    if (!mayRequestReview({ isAuthor, canRequest: can('pull:request-review') }))
      return response.json({ error: 'Forbidden' }, 403)

    // A reviewer who cannot read the repository cannot review it, and adding
    // them would show a request that can never be answered.
    if (!await reviewerCanRead(reviewerType, reviewerId, repository))
      return response.json({ error: 'That reviewer cannot see this repository' }, 422)

    const existing = await db
      .selectFrom('pull_request_reviewers')
      .select(['id', 'responded_at'])
      .where('pull_request_id', '=', Number(pullRequest.id))
      .where('reviewer_type', '=', reviewerType)
      .where('reviewer_id', '=', reviewerId)
      .executeTakeFirst()

    const result = requestReview({
      pullRequestState: pullRequest.state as 'open' | 'closed' | 'merged',
      reviewerId,
      reviewerType,
      authorId: Number(pullRequest.author_id),
      alreadyPending: Boolean(existing) && !existing?.responded_at,
      answeredPreviously: Boolean(existing?.responded_at),
    })

    if (!result.ok)
      return response.json({ error: result.error }, result.status)

    if (result.action === 're-requested') {
      await db
        .updateTable('pull_request_reviewers')
        .set({ responded_at: null, requested_by_id: user.id })
        .where('id', '=', Number(existing?.id))
        .execute()
    }
    else if (result.action === 'created') {
      await db
        .insertInto('pull_request_reviewers')
        .values({
          pull_request_id: Number(pullRequest.id),
          reviewer_type: reviewerType,
          reviewer_id: reviewerId,
          requested_by_id: user.id,
          from_code_owners: false,
          responded_at: null,
        })
        .execute()
    }

    // `addressed`, not merely emitted: a review request is aimed at a person
    // rather than broadcast to a thread, so it has to reach somebody who has
    // never touched this repository and is subscribed to nothing.
    //
    // A team request reaches nobody yet - resolving one to its members is
    // phase 1's model - so it is not addressed rather than addressed at a team
    // id that means nothing to `users`.
    const { notify } = await import('../../Notifications/emit')
    await notify('review:requested', {
      actorId: user.id,
      actorHandle: user.handle,
      repositoryId: repository.id,
      owner: String(request.get('owner') ?? '').trim().toLowerCase(),
      repository: repository.name,
      subjectType: 'pull_request',
      subjectId: Number(pullRequest.id),
      number,
      title: String(pullRequest.title ?? ''),
      addressed: reviewerType === 'user' ? [reviewerId] : [],
      subscribeActor: 'participating',
    })

    return response.json({
      number,
      reviewer: { type: reviewerType, id: reviewerId },
      action: result.action,
    }, result.action === 'created' ? 201 : 200)
  },
})

/**
 * Whether the reviewer can read the repository they are being asked about.
 *
 * The user case goes through the same resolver every other action uses rather
 * than re-deriving access here, which is the whole point of having one: a rule
 * copied into an action is a rule that will not be updated with the others.
 *
 * A team is checked by ownership instead of by walking its members. A team
 * belongs to one organization, and asking a team from a different organization
 * is the mistake worth catching.
 */
async function reviewerCanRead(
  reviewerType: 'user' | 'team',
  reviewerId: number,
  repository: GitRepositoryRow,
): Promise<boolean> {
  if (reviewerType === 'team') {
    const team = await db
      .selectFrom('teams')
      .select(['organization_id'])
      .where('id', '=', reviewerId)
      .executeTakeFirst()

    if (!team)
      return false

    return repository.owner_type === 'organization'
      && Number(team.organization_id) === Number(repository.owner_id)
  }

  // Checked before the permission call, because a public repository is readable
  // by anyone and would otherwise say yes to a user id that does not exist.
  const reviewer = await db
    .selectFrom('users')
    .select(['id'])
    .where('id', '=', reviewerId)
    .executeTakeFirst()

  if (!reviewer)
    return false

  const grants = await permissionOn(repository, reviewerId)

  return canOnRepository({
    userId: reviewerId,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }, 'repository:read')
}
