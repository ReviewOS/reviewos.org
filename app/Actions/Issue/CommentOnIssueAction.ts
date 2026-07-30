import { Action } from '@stacksjs/actions'
import { userReferences } from '../Markdown/references'
import { authorizeRepository } from '../Repo/authorize'
import { mayComment } from './state'

/**
 * Comment on an issue or a pull request.
 *
 * Both live in the same table, so this one action serves both and a pull
 * request conversation is an issue conversation, which is what makes
 * `#12` resolve either way.
 */
export default new Action({
  name: 'CommentOnIssue',
  description: 'Add a comment to an issue or pull request',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:comment')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const body = String(request.get('body') ?? '').trim()
    if (!body)
      return response.json({ error: 'A comment needs a body' }, 422)

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'locked'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    if (!mayComment({ locked: Boolean(issue.locked), isMaintainer: can('issue:close') }))
      return response.json({ error: 'This conversation is locked' }, 423)

    const created = await db
      .insertInto('issue_comments')
      .values({
        // Comments are polymorphic so a pull request conversation and an issue
        // conversation are the same thing, which is what makes a pull request
        // reachable as `#12`.
        commentable_type: 'issue',
        commentable_id: Number(issue.id),
        author_id: user.id,
        body,
      })
      .returning(['id'])
      .executeTakeFirst()

    await db
      .updateTable('issues')
      .set((eb: any) => ({ comments_count: eb('comments_count', '+', 1) }))
      .where('id', '=', Number(issue.id))
      .execute()

    // Mentions are parsed here rather than at render time so a notification is
    // sent once, when the comment is written, and not again on every read.
    const mentioned = userReferences(body).map(reference => reference.handle)

    return response.json({
      id: Number(created?.id),
      issue_number: number,
      mentions: [...new Set(mentioned)],
    }, 201)
  },
})
