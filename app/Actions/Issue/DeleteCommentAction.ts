import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { recountComments } from '../Repo/counters'

/**
 * Delete a comment.
 *
 * A real delete, not a tombstone. A comment is usually deleted because it
 * should not have been posted - a leaked credential, someone's address - and
 * leaving "this comment was deleted" in place with the content still in the
 * database is not a delete, it is a promise.
 *
 * The count on the issue moves with it, or the conversation claims a comment
 * that is not there.
 */
export default new Action({
  name: 'DeleteComment',
  description: 'Delete a comment on an issue or pull request',
  method: 'DELETE',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const commentId = Number(request.get('comment_id'))
    const comment = await db
      .selectFrom('issue_comments')
      .select(['id', 'author_id', 'commentable_id'])
      .where('id', '=', commentId)
      .executeTakeFirst()

    if (!comment)
      return response.json({ error: 'No such comment' }, 404)

    // Confirmed against this repository, so a comment id from elsewhere is not
    // deletable by someone with rights here.
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'repository_id'])
      .where('id', '=', Number(comment.commentable_id))
      .executeTakeFirst()

    if (!issue || Number(issue.repository_id) !== Number(repository.id))
      return response.json({ error: 'No such comment' }, 404)

    const isAuthor = Number(comment.author_id) === user.id
    if (!isAuthor && !can('issue:edit-any'))
      return response.json({ error: 'Forbidden' }, 403)

    await db.deleteFrom('issue_comments').where('id', '=', Number(comment.id)).execute()

    await recountComments(Number(issue.id))

    return response.json({ id: Number(comment.id), deleted: true })
  },
})
