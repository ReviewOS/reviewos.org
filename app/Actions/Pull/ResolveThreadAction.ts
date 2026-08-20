import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Resolve or unresolve a review thread.
 *
 * Who may resolve is a judgement about whose concern it was. The reviewer who
 * raised it may close it, and so may someone maintaining the repository; the
 * author of the code may resolve threads on their own pull request, which is
 * how a long review gets tidied as it is addressed.
 */
export default new Action({
  name: 'ResolveThread',
  description: 'Resolve or unresolve a review thread',
  method: 'PUT',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    resolved: { rule: schema.string() },
    thread_id: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'pull:review')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const threadId = Number(request.get('thread_id'))
    const thread = await db
      .selectFrom('review_threads')
      .innerJoin('pull_requests', 'pull_requests.id', '=', 'review_threads.pull_request_id')
      .select([
        'review_threads.id as id',
        'review_threads.resolved as resolved',
        'review_threads.pull_request_id as pull_request_id',
        'pull_requests.author_id as pull_author_id',
        'pull_requests.repository_id as repository_id',
      ])
      .where('review_threads.id', '=', threadId)
      .executeTakeFirst()

    if (!thread || Number(thread.repository_id) !== repository.id)
      return response.json({ error: 'No such thread' }, 404)

    const firstComment = await db
      .selectFrom('review_comments')
      .select(['author_id'])
      .where('review_thread_id', '=', threadId)
      .orderBy('id', 'asc')
      .executeTakeFirst()

    const isReviewer = Number(firstComment?.author_id) === user.id
    const isPullAuthor = Number(thread.pull_author_id) === user.id

    if (!isReviewer && !isPullAuthor && !can('pull:merge'))
      return response.json({ error: 'Forbidden' }, 403)

    const resolved = request.get('resolved') === undefined ? true : Boolean(request.get('resolved'))

    await db
      .updateTable('review_threads')
      .set({
        resolved,
        resolved_by_id: resolved ? user.id : null,
      })
      .where('id', '=', threadId)
      .execute()

    // Resolving the last thread may be the last requirement. Does nothing
    // unless somebody armed auto-merge, and never throws.
    if (resolved) {
      const { attemptAutoMerge } = await import('./autoMerge')
      await attemptAutoMerge(Number(thread.pull_request_id))
    }

    return response.json({ thread_id: threadId, resolved })
  },
})
