import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { isReaction } from '../Markdown/emoji'
import { authorizeRepository } from '../Repo/authorize'
import { toggleReaction } from './reactions'
import { mayComment } from './state'
import { coerced } from '../inputs'

/**
 * React to an issue, or to a comment on one.
 *
 * Anybody who can comment can react, and for the same reason ticking a task
 * item is open to them: a reaction is the cheapest way to say "me too" or "I
 * disagree" without adding a comment nobody wants to read. Requiring write
 * access would push those people into writing "+1" instead, which is the
 * outcome the feature exists to prevent.
 *
 * A locked conversation refuses reactions along with comments. Locking is a
 * decision that the thread is finished, and a row of thumbs still climbing
 * under it says otherwise.
 *
 * One endpoint, toggling. The page cannot know whether the button it is drawing
 * has already been pressed by the time the click arrives, so asking it to
 * choose between "add" and "remove" is asking it to guess.
 */
export default new Action({
  name: 'React',
  description: 'Add or remove a reaction on an issue or a comment',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    comment_id: { rule: coerced },
    content: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'issue:react')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const content = String(request.get('content') ?? '')
    if (!isReaction(content))
      return response.json({ error: 'No such reaction' }, 422)

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

    const commentId = request.get('comment_id') ? Number(request.get('comment_id')) : null

    // A comment is reached through the issue it belongs to, so a comment id
    // from another issue - or another repository - cannot be reacted to by
    // naming it here. The same containment `ToggleTaskAction` uses.
    if (commentId !== null) {
      const comment = await db
        .selectFrom('issue_comments')
        .select(['id'])
        .where('id', '=', commentId)
        .where('commentable_type', '=', 'issue')
        .where('commentable_id', '=', Number(issue.id))
        .executeTakeFirst()

      if (!comment)
        return response.json({ error: 'No such comment' }, 404)
    }

    const subject = commentId !== null
      ? { type: 'issue_comment' as const, id: commentId }
      : { type: 'issue' as const, id: Number(issue.id) }

    const result = await toggleReaction(subject, user.id, content)

    return response.json({ number, comment_id: commentId, content, reacted: result.reacted })
  },
})
