import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { recordCrossReferences } from './crossReferences'

/**
 * Edit a comment.
 *
 * `edited_at` and `edited_by_id` are stamped rather than the change being made
 * quietly: a conversation people are relying on has to show when a message
 * stopped saying what it said, and by whom when it was not the author.
 *
 * Serves issues and pull requests, like the comment endpoint it edits.
 */
export default new Action({
  name: 'UpdateComment',
  description: 'Edit a comment on an issue or pull request',
  method: 'PUT',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const body = String(request.get('body') ?? '').trim()
    if (!body)
      return response.json({ error: 'A comment needs a body' }, 422)

    const commentId = Number(request.get('comment_id'))
    const comment = await db
      .selectFrom('issue_comments')
      .select(['id', 'author_id', 'commentable_id'])
      .where('id', '=', commentId)
      .executeTakeFirst()

    if (!comment)
      return response.json({ error: 'No such comment' }, 404)

    // The comment is found by id, so its repository has to be confirmed
    // separately: without this, a comment id from another repository would be
    // editable by anyone with rights on this one.
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'number', 'repository_id', 'locked', 'is_pull_request'])
      .where('id', '=', Number(comment.commentable_id))
      .executeTakeFirst()

    if (!issue || Number(issue.repository_id) !== Number(repository.id))
      return response.json({ error: 'No such comment' }, 404)

    const isAuthor = Number(comment.author_id) === user.id
    if (!isAuthor && !can('issue:edit-any'))
      return response.json({ error: 'Forbidden' }, 403)

    if (issue.locked && !can('issue:close'))
      return response.json({ error: 'This conversation is locked' }, 423)

    await db
      .updateTable('issue_comments')
      .set({ body, edited_at: new Date().toISOString(), edited_by_id: user.id })
      .where('id', '=', Number(comment.id))
      .execute()

    // A reference added while editing is as real as one written first time.
    const references = await recordCrossReferences(
      {
        subject: {
          type: issue.is_pull_request ? 'pull_request' : 'issue',
          id: Number(issue.id),
        },
        number: Number(issue.number),
        repositoryId: Number(repository.id),
      },
      user.id,
      body,
    )

    return response.json({ id: Number(comment.id), body, edited: true, references })
  },
})
