import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { suggestionIn } from './suggestions'

/**
 * Start a review thread on a line, or reply to one.
 *
 * The thread records the commit and the line it was written against, alongside
 * the line it currently points at. The first pair never changes, which is what
 * lets an outdated thread still show the code it was about; the second is what
 * moves when the branch does.
 */
export default new Action({
  name: 'CommentOnCode',
  description: 'Comment on a line of a pull request diff',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:review')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const body = String(request.get('body') ?? '').trim()
    if (!body)
      return response.json({ error: 'A comment needs a body' }, 422)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const replyTo = request.get('thread_id') ? Number(request.get('thread_id')) : null

    if (replyTo !== null) {
      const thread = await db
        .selectFrom('review_threads')
        .select(['id'])
        .where('id', '=', replyTo)
        .where('pull_request_id', '=', Number(pullRequest.id))
        .executeTakeFirst()

      // A thread id from another pull request would attach this reply to a
      // conversation the author cannot see.
      if (!thread)
        return response.json({ error: 'No such thread' }, 404)

      const reply = await db
        .insertInto('review_comments')
        .values({
          review_thread_id: replyTo,
          author_id: user.id,
          body,
          suggestion: suggestionIn(body),
        })
        .returning(['id'])
        .executeTakeFirst()

      return response.json({ id: Number(reply?.id), thread_id: replyTo }, 201)
    }

    const path = String(request.get('path') ?? '').trim()
    const line = Number(request.get('line'))
    const side = String(request.get('side') ?? 'right')

    if (!path)
      return response.json({ error: 'A thread needs a file' }, 422)

    if (!Number.isInteger(line) || line < 1)
      return response.json({ error: 'A thread needs a line' }, 422)

    if (side !== 'left' && side !== 'right')
      return response.json({ error: 'Side must be left or right' }, 422)

    const startLine = request.get('start_line') ? Number(request.get('start_line')) : null
    if (startLine !== null && (!Number.isInteger(startLine) || startLine > line))
      return response.json({ error: 'A multi-line comment must start above the line it ends on' }, 422)

    const thread = await db
      .insertInto('review_threads')
      .values({
        pull_request_id: Number(pullRequest.id),
        path,
        line,
        start_line: startLine,
        side,
        original_line: line,
        original_commit_sha: pullRequest.head_sha,
        resolved: false,
        outdated: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    const threadId = Number(thread?.id)

    const comment = await db
      .insertInto('review_comments')
      .values({
        review_thread_id: threadId,
        author_id: user.id,
        body,
        suggestion: suggestionIn(body),
      })
      .returning(['id'])
      .executeTakeFirst()

    return response.json({ id: Number(comment?.id), thread_id: threadId, path, line, side }, 201)
  },
})
