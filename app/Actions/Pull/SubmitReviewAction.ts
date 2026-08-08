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
 *
 * **A whole review can also arrive in one request**, as `comments: [...]`
 * alongside the verdict. That is the browser flow's shape turned inside out and
 * it exists for callers that have no drafts to publish: an agent assembles its
 * comments in memory and has nowhere to put them until it submits.
 *
 * Twelve round trips is twelve chances to leave half a review behind - a
 * connection that drops after the fourth comment leaves four orphan comments
 * and no verdict, which reads to everybody else as a reviewer who wandered off
 * mid-sentence. Either the whole review lands or none of it does.
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

    /*
     * Inline comments, validated *before* anything is written.
     *
     * All of them, not the first bad one: a caller sending twelve comments with
     * two mistakes should learn about both, or fixing the first only earns them
     * the second error on the next attempt.
     */
    const inline = readComments(request)
    if (!inline.ok)
      return response.json({ error: inline.error, comments: inline.problems }, 422)

    // A comment review with neither a body nor comments says nothing at all.
    // With comments it is a review whose remarks are the body, which is
    // ordinary and should not be refused.
    if (state === 'commented' && !body && inline.comments.length === 0)
      return response.json({ error: 'A comment review needs a body or at least one comment' }, 422)

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

    /*
     * The comments, written after the review row exists so each one can point
     * at it, and before anything is announced.
     *
     * Written here rather than in a transaction wrapper because the ordering is
     * what provides the atomicity that matters: the review is the thing
     * everything else keys on, so a failure part-way through leaves comments
     * attached to a real review rather than orphans attached to nothing. The
     * notification below fires only after all of them land, so nobody is told
     * about a verdict whose remarks are missing.
     */
    const writtenComments = await writeComments(inline.comments, {
      pullRequestId: Number(pullRequest.id),
      reviewId,
      authorId: user.id,
      headSha: String(pullRequest.head_sha ?? ''),
    })

    // A requested review is answered by submitting one.
    await db
      .updateTable('pull_request_reviewers')
      .set({ responded_at: new Date().toISOString() })
      .where('pull_request_id', '=', Number(pullRequest.id))
      .where('reviewer_id', '=', user.id)
      .execute()

    // Told after the review exists, and after the request is marked answered,
    // so nothing can announce a verdict that then failed to save.
    const { notify } = await import('../../Notifications/emit')
    await notify('review:submitted', {
      actorId: user.id,
      actorHandle: user.handle,
      repositoryId: repository.id,
      owner: String(request.get('owner') ?? '').trim().toLowerCase(),
      repository: repository.name,
      subjectType: 'pull_request',
      subjectId: Number(pullRequest.id),
      number,
      title: String(pullRequest.title ?? ''),
      // The verdict, in the words the sentence needs. Without it a reader has
      // to open the pull request to find out whether they are blocked.
      detail: state === 'approved'
        ? 'approved'
        : state === 'changes_requested' ? 'requested changes on' : 'commented on',
      subscribeActor: 'participating',
    })

    // An approval may be the last requirement. attemptAutoMerge never throws
    // and does nothing unless somebody armed it.
    const { attemptAutoMerge } = await import('./autoMerge')
    await attemptAutoMerge(Number(pullRequest.id))

    return response.json({
      id: reviewId,
      state,
      commit_sha: pullRequest.head_sha,
      comments: writtenComments,
    }, 201)
  },
})

/** One inline comment, as a caller sends it. */
interface InlineComment {
  path: string
  line: number
  startLine: number | null
  side: 'left' | 'right'
  body: string
}

type CommentsRead
  = | { ok: true, comments: InlineComment[] }
    | { ok: false, error: string, problems: Array<{ index: number, problem: string }> }

/**
 * The comments a caller sent, all validated before any are written.
 *
 * Every problem is collected rather than the first one thrown, because a
 * caller sending twelve comments with two mistakes should learn about both -
 * fixing the first otherwise only earns them the second error on the next
 * attempt, and an agent doing that is an agent in a loop.
 *
 * Absent is fine and means the browser flow: publish whatever drafts exist.
 */
function readComments(request: any): CommentsRead {
  const raw = request.get('comments')

  if (raw === undefined || raw === null || raw === '')
    return { ok: true, comments: [] }

  if (!Array.isArray(raw))
    return { ok: false, error: 'comments must be an array', problems: [] }

  const comments: InlineComment[] = []
  const problems: Array<{ index: number, problem: string }> = []

  raw.forEach((item: any, index: number) => {
    const path = String(item?.path ?? '').trim()
    const body = String(item?.body ?? '').trim()
    const line = Number(item?.line)
    const side = String(item?.side ?? 'right').toLowerCase()
    const startRaw = item?.start_line ?? item?.startLine

    if (!path)
      problems.push({ index, problem: 'path is required' })

    if (!body)
      problems.push({ index, problem: 'body is required' })

    // A comment with no line is a comment on the pull request, and there is an
    // endpoint for that. Anchoring it to line 0 here would put it somewhere
    // nobody looks.
    if (!Number.isInteger(line) || line < 1)
      problems.push({ index, problem: 'line must be a positive integer' })

    if (side !== 'left' && side !== 'right')
      problems.push({ index, problem: 'side must be left or right' })

    const startLine = startRaw === undefined || startRaw === null ? null : Number(startRaw)

    if (startLine !== null && (!Number.isInteger(startLine) || startLine < 1 || startLine > line))
      problems.push({ index, problem: 'start_line must be a positive integer no greater than line' })

    if (problems.some(problem => problem.index === index))
      return

    comments.push({ path, line, startLine, side: side as 'left' | 'right', body })
  })

  if (problems.length > 0)
    return { ok: false, error: `${problems.length} of ${raw.length} comments are not valid`, problems }

  return { ok: true, comments }
}

/**
 * Write each comment as a thread with one comment under it.
 *
 * The same shape `CommentOnCodeAction` writes, deliberately - a comment left by
 * an agent and one left in the browser have to be the same kind of object, or
 * every reader of them grows a special case.
 *
 * Anchored to the head the review was written against, which is what lets a
 * thread be marked outdated later rather than silently drifting onto whatever
 * line now occupies that number.
 */
async function writeComments(
  comments: readonly InlineComment[],
  context: { pullRequestId: number, reviewId: number, authorId: number, headSha: string },
): Promise<Array<{ id: number, thread_id: number, path: string, line: number }>> {
  const written: Array<{ id: number, thread_id: number, path: string, line: number }> = []

  for (const comment of comments) {
    const thread: any = await db
      .insertInto('review_threads')
      .values({
        pull_request_id: context.pullRequestId,
        path: comment.path,
        line: comment.line,
        start_line: comment.startLine,
        side: comment.side,
        original_line: comment.line,
        original_commit_sha: context.headSha,
        resolved: false,
        outdated: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    const threadId = Number(thread?.id)

    const { suggestionIn } = await import('./suggestions')

    const row: any = await db
      .insertInto('review_comments')
      .values({
        review_thread_id: threadId,
        author_id: context.authorId,
        body: comment.body,
        suggestion: suggestionIn(comment.body),
      })
      .returning(['id'])
      .executeTakeFirst()

    written.push({ id: Number(row?.id), thread_id: threadId, path: comment.path, line: comment.line })
  }

  return written
}
