/**
 * The decisions the file list makes, separated from the DOM it makes them in.
 *
 * Two of them: which files a search leaves, and which files the reader has
 * marked as read. Both are pure over values, and both are the kind of thing
 * that is easy to get subtly wrong and impossible to see in a screenshot - a
 * filter that quietly drops a file, a viewed set that forgets which pull
 * request it belonged to.
 */

/**
 * Whether a path matches a search.
 *
 * Every whitespace-separated term has to appear somewhere in the path, in any
 * order and anywhere. That is what lets `cart test` find
 * `tests/commerce/cart.test.ts` without the reader having to remember which
 * order the directories come in - which is the whole reason they are searching
 * rather than scrolling.
 *
 * Substring rather than fuzzy subsequence, deliberately. Subsequence matching
 * makes `art` match `app/routes/tree.ts` through three unrelated letters, and a
 * filter that returns files the reader cannot see the reason for is worse than
 * one that returns none.
 */
export function matchesQuery(path: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0)
    return true

  const haystack = path.toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/**
 * The positions of the files a search leaves, in order.
 *
 * Positions rather than the files themselves, because everything downstream -
 * the diff, the scroll target, the viewed set - is addressed by position in the
 * diff, and a filtered list that renumbered its rows would scroll to the wrong
 * file the moment somebody typed anything.
 */
export function filterFiles(
  files: readonly { path: string }[],
  query: string,
  /**
   * A second, non-textual filter: only these paths, whatever the search says.
   *
   * This is what "since I last looked" narrows the list with. It composes with
   * the search rather than replacing it - a reviewer who has restricted the
   * list to eleven files and then types into the box means "of those eleven",
   * and a filter that quietly dropped the restriction would hand them back the
   * three hundred they were trying to escape.
   */
  restrict?: ReadonlySet<string> | null,
): number[] {
  const trimmed = query.trim()
  const indexes: number[] = []

  for (let index = 0; index < files.length; index++) {
    const path = files[index]!.path

    if (restrict != null && !restrict.has(path))
      continue

    if (trimmed === '' || matchesQuery(path, trimmed))
      indexes.push(index)
  }

  return indexes
}

/**
 * Where one pull request's viewed files are remembered.
 *
 * Keyed by the pull request, so marking a file read on one does not mark it
 * read on every other pull request that happens to touch the same path - which
 * is exactly what a key of just the path would do, and it would look like the
 * feature working until somebody noticed a file they had never opened was
 * already ticked.
 */
export function viewedKey(scope: string): string {
  return `reviewos:viewed:${scope}`
}

/**
 * The paths marked as read, for one pull request.
 *
 * Never throws. Storage is refused in Safari's private browsing and in a frame
 * with third-party storage blocked, and a reader who cannot be remembered still
 * gets a working list.
 */
export function readViewed(scope: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(viewedKey(scope))
    if (raw == null)
      return new Set()

    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : [])
  }
  catch {
    return new Set()
  }
}

export function writeViewed(scope: string, paths: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(viewedKey(scope), JSON.stringify([...paths]))
  }
  catch {
    // Not being remembered is not a reason to stop.
  }
}

/**
 * A comment somebody started writing and has not sent.
 *
 * Kept where the viewed set is kept, and for the same reason: a review is not
 * one sitting. Somebody writes half a comment, goes to look at the issue it
 * refers to, and comes back - and losing the words to a navigation is the
 * single most annoying thing a review interface can do, because it is entirely
 * avoidable and it is always the sentence that took the longest to write.
 *
 * One per pull request. The viewer only allows one draft open at a time, so
 * there is never a second to keep.
 */
export interface StoredDraft {
  path: string
  side: 'left' | 'right'
  from: number
  to: number
  text: string
}

function draftKey(scope: string): string {
  return `reviewos:draft:${scope}`
}

export function readDraft(scope: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(scope))
    if (raw == null)
      return null

    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object')
      return null

    const draft = parsed as Record<string, unknown>
    const side = draft.side === 'left' || draft.side === 'right' ? draft.side : null

    // Every field checked, because this was written by a version of this code
    // that may not be this one, and a draft restored onto the wrong line would
    // be a comment about code it is not about.
    if (typeof draft.path !== 'string' || side == null || typeof draft.text !== 'string')
      return null
    if (!Number.isFinite(draft.from) || !Number.isFinite(draft.to))
      return null

    return { path: draft.path, side, from: Number(draft.from), to: Number(draft.to), text: draft.text }
  }
  catch {
    return null
  }
}

export function writeDraft(scope: string, draft: StoredDraft | null): void {
  try {
    if (draft == null || draft.text.trim() === '')
      window.localStorage.removeItem(draftKey(scope))
    else
      window.localStorage.setItem(draftKey(scope), JSON.stringify(draft))
  }
  catch {
    // Not being remembered is not a reason to stop.
  }
}
