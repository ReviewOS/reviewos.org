import { Action } from '@stacksjs/actions'
import { toggleTask } from '../Markdown/tasks'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Tick or untick one task list item, on an issue body or on a comment.
 *
 * The edit lands in the markdown source, character for character: the rendered
 * checkbox is a view of the document, not the document. Everything else in the
 * body is left exactly as written, because a body is somebody's writing and
 * ticking a box is not permission to reformat it.
 *
 * Anybody who can comment can tick a box. That is the point of a checklist on a
 * shared issue - it is a coordination device, and gating it behind write access
 * makes it a status report from the maintainers instead. Editing the surrounding
 * *text* still needs the ordinary edit permission; this endpoint cannot change
 * anything but the three characters inside the brackets.
 */
export default new Action({
  name: 'ToggleTask',
  description: 'Tick or untick a task list item',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:comment')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const commentId = request.get('comment_id') ? Number(request.get('comment_id')) : null
    const index = Number(request.get('index'))
    const checked = String(request.get('checked') ?? '') === 'true'
    const expectedRaw = request.get('expected')
    const expected = expectedRaw === undefined || expectedRaw === null
      ? undefined
      : String(expectedRaw) === 'true'

    const issue = await db
      .selectFrom('issues')
      .select(['id', 'body', 'locked'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    // A locked conversation is locked for this too. Ticking somebody's checklist
    // on a thread that has been closed to comment is the same act.
    if (issue.locked)
      return response.json({ error: 'This conversation is locked' }, 403)

    if (commentId !== null)
      return toggleOnComment(commentId, Number(issue.id), index, checked, expected)

    const result = toggleTask(String(issue.body ?? ''), index, checked, expected)
    if (!result.ok)
      return response.json({ error: result.error }, 409)

    if (result.changed) {
      await db
        .updateTable('issues')
        .set({ body: result.source })
        .where('id', '=', Number(issue.id))
        .execute()
    }

    return response.json({ number, index, checked, changed: result.changed })
  },
})

/**
 * The same, on a comment.
 *
 * Scoped to the issue it was reached through, so a comment id from another
 * issue - or another repository - cannot be edited by asking for it here.
 */
async function toggleOnComment(
  commentId: number,
  issueId: number,
  index: number,
  checked: boolean,
  expected: boolean | undefined,
) {
  const comment = await db
    .selectFrom('issue_comments')
    .select(['id', 'body'])
    .where('id', '=', commentId)
    .where('commentable_type', '=', 'issue')
    .where('commentable_id', '=', issueId)
    .executeTakeFirst()

  if (!comment)
    return response.json({ error: 'No such comment' }, 404)

  const result = toggleTask(String(comment.body ?? ''), index, checked, expected)
  if (!result.ok)
    return response.json({ error: result.error }, 409)

  if (result.changed) {
    await db
      .updateTable('issue_comments')
      .set({ body: result.source })
      .where('id', '=', commentId)
      .execute()
  }

  // Deliberately not marked as edited: `edited_at` means somebody rewrote what
  // was said, and a ticked box is not that.
  return response.json({ comment_id: commentId, index, checked, changed: result.changed })
}
