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
import { placeThread, reanchor } from './anchoring'

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
  /**
   * The line it was written about is gone from the head.
   *
   * Set by tracking, not by placement. Placement asks "where does this sit in
   * the diff on screen"; this answers "does the code still exist", which only
   * the intervening diff can say.
   */
  outdated?: boolean
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
  /**
   * Carry each thread from the head it was written against to this one.
   *
   * Optional because a caller with no repository on hand can still read the
   * conversation, and a thread on its original head needs no carrying anyway.
   * Absent means the stored line is used as-is, which is right whenever the
   * branch has not moved and wrong by however far it has.
   */
  trackTo?: { diskPath: string, headSha: string }
}

/** Every thread on a pull request, as stored, with its comments rendered. */
export async function loadReviewThreads(options: LoadThreadsOptions): Promise<StoredThread[]> {
  const { pullRequestId, renderBody } = options

  const threadRows = await db
    .selectFrom('review_threads')
    .selectAll()
    .where('pull_request_id', '=', pullRequestId)
    .orderBy('id', 'asc')
    .execute()

  if (threadRows.length === 0)
    return []

  const commentRows = await db
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

  const threads = await Promise.all(threadRows.map(async row => ({
    id: Number(row.id),
    path: String(row.path),
    line: Number(row.line),
    originalLine: Number(row.original_line ?? row.line),
    side: row.side === 'left' ? 'left' : 'right',
    resolved: Boolean(row.resolved),
    outdated: Boolean(row.outdated),
    comments: await Promise.all((byThread.get(Number(row.id)) ?? []).map(async comment => ({
      id: Number(comment.id),
      authorHandle: String(comment.handle ?? comment.external_author ?? 'someone'),
      bodyHtml: await renderBody(String(comment.body ?? '')),
      createdAt: String(comment.created_at ?? ''),
    }))),
  } satisfies StoredThread)))

  return options.trackTo
    ? await trackThreads(threads, threadRows, options.trackTo)
    : threads
}

/**
 * Carry each thread from the head it was written against to the current one.
 *
 * The operation is `reanchor`, which has always been right and has never been
 * given the diff it documents. This is that diff: two dots, from the thread's
 * `original_commit_sha` to the head being shown. Three dots would silently do
 * nothing after a rebase, because the merge base moves with the rebase and the
 * intervening change vanishes from the answer.
 *
 * Grouped by that sha, so a pull request with forty threads from three rounds
 * of review costs three `git diff` calls rather than forty. Threads already on
 * the current head cost none, which is the common case: most reviews are read
 * before anybody pushes again.
 *
 * Failure is not fatal. A sha that has been garbage collected after a
 * force-push cannot be diffed, and the honest answer is the thread where it was
 * rather than no threads at all - a review that disappears because git could
 * not answer a question about it is worse than one that is a line out.
 */
async function trackThreads(
  threads: StoredThread[],
  rows: readonly any[],
  to: { diskPath: string, headSha: string },
): Promise<StoredThread[]> {
  const shaFor = new Map<number, string>()
  for (const row of rows) {
    const sha = String(row.original_commit_sha ?? '').trim()
    if (sha && sha !== to.headSha)
      shaFor.set(Number(row.id), sha)
  }

  if (shaFor.size === 0)
    return threads

  const distinct = [...new Set(shaFor.values())]
  const diffs = new Map<string, DiffFile[]>()

  await Promise.all(distinct.map(async (sha) => {
    const files = await filesBetween(to.diskPath, sha, to.headSha)
    if (files)
      diffs.set(sha, files)
  }))

  return threads.map((thread) => {
    const sha = shaFor.get(thread.id)
    const files = sha ? diffs.get(sha) : undefined
    if (!files)
      return thread

    const outcome = reanchor({ path: thread.path, line: thread.line, side: thread.side }, files)

    return outcome.status === 'outdated'
      ? { ...thread, path: outcome.anchor.path, outdated: true }
      : { ...thread, path: outcome.anchor.path, line: outcome.anchor.line }
  })
}

/** The parsed diff between two commits, or null when git could not produce it. */
async function filesBetween(diskPath: string, from: string, to: string): Promise<DiffFile[] | null> {
  const { streamCommitRangeDiff } = await import('../Git/diffStream')
  const { parseDiff } = await import('./diff')

  const diff = streamCommitRangeDiff(diskPath, from, to)
  if (!diff)
    return null

  try {
    let patch = ''
    for await (const chunk of diff.chunks)
      patch += chunk

    const ended = await diff.done
    return ended.ok ? parseDiff(patch) : null
  }
  catch {
    diff.cancel()
    return null
  }
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
    // `placeThread`, not `reanchor`: this is the diff on screen, and a thread's
    // line is already a position in it. See the note on `placeThread` for what
    // mapping it instead did to every comment on an added line.
    const outcome = placeThread({ path: thread.path, line: thread.line, side: thread.side }, files)

    // Either way of going outdated counts. Tracking says the code is gone from
    // the head; placement says there is nowhere in this diff to put it. A
    // thread that survived one and not the other is still outdated.
    const outdated = outcome.status === 'outdated' || thread.outdated === true

    return {
      id: thread.id,
      path: outcome.anchor.path,
      // An outdated thread shows the line it was written about, which is the
      // only number that still means anything once the line itself is gone.
      line: outdated ? thread.originalLine : outcome.anchor.line,
      side: outcome.anchor.side,
      resolved: thread.resolved,
      outdated,
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
