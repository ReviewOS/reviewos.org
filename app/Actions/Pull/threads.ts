/**
 * Review threads, as markup and as a rule for where they go.
 *
 * The rule is the important half. A thread on the right-hand side matches the
 * new line number and one on the left matches the old, and matching on both at
 * once is how a comment written about a removed line ends up printed under the
 * line that replaced it - saying the opposite of what its author meant.
 *
 * The markup is here rather than in a component for the same reason the rows
 * are: two paths render a diff, and a thread has to look the same in both. It
 * matches `ReviewThread.stx` element for element, so the component can be
 * replaced by a call to this without the page changing.
 */

import type { DiffLine } from './diff'
import { escapeHtml } from './rows'

export interface ThreadComment {
  id: number
  authorHandle: string
  /** Already rendered. Markdown is a server concern and is done before this. */
  bodyHtml: string
  createdAt: string
}

export interface ReviewThreadView {
  id: number
  path: string
  /** Null when the thread could not be placed at all. */
  line: number | null
  side: 'left' | 'right'
  resolved: boolean
  /** The line it was written about has changed. Shown, never hidden. */
  outdated: boolean
  comments: ThreadComment[]
}

/**
 * The threads that belong under one line of one file.
 *
 * Filtered rather than indexed because a line usually has none and the lists
 * are short. If a file ever carries enough threads for this to matter, the
 * index belongs in the caller, which knows the whole file.
 */
export function threadsForLine(
  threads: readonly ReviewThreadView[],
  path: string,
  line: Pick<DiffLine, 'oldLine' | 'newLine'>,
): ReviewThreadView[] {
  return threads.filter((thread) => {
    if (thread.path !== path || thread.line === null)
      return false

    return thread.side === 'right'
      ? line.newLine === thread.line
      : line.oldLine === thread.line
  })
}

/**
 * One conversation.
 *
 * An outdated thread is rendered, not dropped. The conversation that produced a
 * change is the record of why the code looks like it does, and losing it to a
 * rebase is the failure the anchoring module exists to prevent; the interface
 * must not quietly finish the job.
 */
export function renderThread(thread: ReviewThreadView): string {
  const outdated = thread.outdated
    ? `<span class="pill pill-draft" title="The line this was written about has changed">Outdated</span>`
    : ''
  const resolved = thread.resolved ? `<span class="pill pill-merged">Resolved</span>` : ''

  const comments = thread.comments.map(comment => `<li class="comment">`
    + `<div class="comment-head">`
    + `<span class="comment-author">${escapeHtml(comment.authorHandle)}</span>`
    + `<span class="muted comment-time">${escapeHtml(comment.createdAt)}</span>`
    + `</div>`
    // Already HTML: rendered from markdown before it reached here, and escaping
    // it again would print the tags.
    + `<div class="comment-body markdown">${comment.bodyHtml}</div>`
    + `</li>`).join('')

  return `<article class="thread${thread.resolved ? ' is-resolved' : ''}">`
    + `<header class="thread-head">${outdated}${resolved}`
    + `<span class="muted thread-anchor mono">${escapeHtml(thread.path)}:${thread.line ?? '?'}</span>`
    + `</header>`
    + `<ol class="thread-comments">${comments}</ol>`
    + renderReplyForm(thread)
    + `</article>`
}

/** Every thread under one line, in order. */
export function renderThreads(threads: readonly ReviewThreadView[]): string {
  return threads.map(thread => renderThread(thread)).join('')
}

/**
 * Replying and resolving, as a plain form.
 *
 * Two submit buttons against two endpoints rather than one endpoint that
 * guesses: resolving is not a reply with an empty body, and a form that works
 * before any JavaScript runs is the difference between a review screen that
 * degrades and one that stops.
 */
function renderReplyForm(thread: ReviewThreadView): string {
  const id = thread.id

  return `<form class="thread-reply" method="post" action="/api/repos/pulls/comments">`
    + `<input type="hidden" name="thread_id" value="${id}">`
    + `<label class="visually-hidden" for="reply-${id}">Reply to this thread</label>`
    + `<textarea id="reply-${id}" name="body" rows="2" placeholder="Reply" class="reply-input"></textarea>`
    + `<div class="thread-actions">`
    + `<button type="submit" class="btn btn-primary">Reply</button>`
    + `<button type="submit" class="btn" formaction="/api/repos/pulls/threads" formmethod="post"`
    + ` name="resolved" value="${thread.resolved ? 'false' : 'true'}">`
    + `${thread.resolved ? 'Unresolve' : 'Resolve'}</button>`
    + `</div></form>`
}

/**
 * A `threadsAt` slot for `renderDiffRows`, bound to one file.
 *
 * The rows renderer knows nothing about threads beyond where they go; this is
 * what connects the two without either knowing the other's shape.
 */
export function threadSlotFor(
  threads: readonly ReviewThreadView[],
  path: string,
): (line: DiffLine) => string {
  if (threads.length === 0)
    return () => ''

  // Only the threads on this file, so every line is matched against a short
  // list rather than against every thread on the pull request.
  const own = threads.filter(thread => thread.path === path)
  if (own.length === 0)
    return () => ''

  return line => renderThreads(threadsForLine(own, path, line))
}
