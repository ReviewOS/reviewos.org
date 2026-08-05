/**
 * Getting a pull request's review threads out of the database and onto lines.
 *
 * Lifted out of the conversation view so both screens read them the same way.
 * The view had this inline, which meant the streamed review screen would either
 * have grown a second copy or gone without threads, and a review screen without
 * threads is a diff viewer.
 *
 * Re-anchoring happens here because a thread is stored against the commit it
 * was written on, and by the time anybody reads it the branch has usually
 * moved. Following it through the intervening diffs is what keeps a comment
 * next to the code it is about; when the line is genuinely gone the thread is
 * marked outdated and still shown.
 */

import type { DiffFile } from './diff'
import type { ReviewThreadView, ThreadComment } from './threads'
import { reanchor } from './anchoring'

/**
 * A thread as it is stored, before it has been placed on a current line.
 *
 * Kept separate from the placed form because the manifest streams one file at a
 * time and never holds the whole diff: threads are loaded once, and each one is
 * anchored when its file goes past.
 */
export interface StoredThread {
  id: number
  path: string
  line: number
  originalLine: number
  side: 'left' | 'right'
  resolved: boolean
  comments: ThreadComment[]
}

export interface LoadThreadsOptions {
  pullRequestId: number
  /**
   * Turn a comment body into HTML.
   *
   * Passed in rather than imported so this module does not depend on the
   * markdown renderer, which needs a repository context to resolve `#12` and
   * would drag that requirement into everything that loads a thread.
   */
  renderBody: (body: string) => Promise<string>
}

/** Every thread on a pull request, as stored, with its comments rendered. */
export async function loadReviewThreads(options: LoadThreadsOptions): Promise<StoredThread[]> {
  const { pullRequestId, renderBody } = options

  const threadRows: any[] = await db
    .selectFrom('review_threads')
    .selectAll()
    .where('pull_request_id', '=', pullRequestId)
    .orderBy('id', 'asc')
    .execute()

  if (threadRows.length === 0)
    return []

  const commentRows: any[] = await db
    .selectFrom('review_comments')
    // A LEFT join, not an inner one: a comment whose author has no local
    // account - mirrored from elsewhere, or written by an account since
    // deleted - is still something someone wrote, and an inner join drops it
    // from the review entirely without saying so.
    .leftJoin('users', 'users.id', '=', 'review_comments.author_id')
    .select([
      'review_comments.id as id',
      'review_comments.review_thread_id as review_thread_id',
      'review_comments.body as body',
      'review_comments.created_at as created_at',
      'review_comments.external_author as external_author',
      'users.handle as handle',
    ])
    .where('review_comments.review_thread_id', 'in', threadRows.map(row => Number(row.id)))
    .orderBy('review_comments.id', 'asc')
    .execute()

  const byThread = new Map<number, any[]>()
  for (const comment of commentRows) {
    const key = Number(comment.review_thread_id)
    const existing = byThread.get(key)
    if (existing)
      existing.push(comment)
    else
      byThread.set(key, [comment])
  }

  return await Promise.all(threadRows.map(async row => ({
    id: Number(row.id),
    path: String(row.path),
    line: Number(row.line),
    originalLine: Number(row.original_line ?? row.line),
    side: row.side === 'left' ? 'left' : 'right',
    resolved: Boolean(row.resolved),
    comments: await Promise.all((byThread.get(Number(row.id)) ?? []).map(async comment => ({
      id: Number(comment.id),
      authorHandle: String(comment.handle ?? comment.external_author ?? 'someone'),
      bodyHtml: await renderBody(String(comment.body ?? '')),
      createdAt: String(comment.created_at ?? ''),
    }))),
  } satisfies StoredThread)))
}

/**
 * Place threads on the lines they are about now.
 *
 * Given whichever files are in hand: the conversation view passes all of them,
 * and the streamed manifest passes one, because it holds one at a time. A
 * thread whose file is not among them comes back anchored where it was stored,
 * which is correct - nothing in this diff moved it - and is then filtered out
 * by the file it does not belong to.
 */
export function anchorThreads(
  threads: readonly StoredThread[],
  files: readonly DiffFile[],
): ReviewThreadView[] {
  return threads.map((thread) => {
    const outcome = reanchor({ path: thread.path, line: thread.line, side: thread.side }, files)

    return {
      id: thread.id,
      path: outcome.anchor.path,
      // An outdated thread shows the line it was written about, which is the
      // only number that still means anything once the line itself is gone.
      line: outcome.status === 'outdated' ? thread.originalLine : outcome.anchor.line,
      side: outcome.anchor.side,
      resolved: thread.resolved,
      outdated: outcome.status === 'outdated',
      comments: thread.comments,
    } satisfies ReviewThreadView
  })
}

/**
 * The threads on one file, anchored against it.
 *
 * The streaming form. Filtering first means a pull request with two hundred
 * threads does not re-anchor all of them once per file.
 */
export function anchorThreadsToFile(
  threads: readonly StoredThread[],
  file: DiffFile,
): ReviewThreadView[] {
  const own = threads.filter(thread => thread.path === file.path || thread.path === file.previousPath)
  return own.length === 0 ? [] : anchorThreads(own, [file])
}
