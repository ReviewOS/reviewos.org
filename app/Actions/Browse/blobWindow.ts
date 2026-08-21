/**
 * A range of a file's lines, without holding the file.
 *
 * `readBlob` collects the whole blob into a string and refuses anything over
 * half a megabyte, which is the right trade for a page that renders every line
 * it reads: a browser handed a vendored bundle stops responding, so the ceiling
 * protects the reader as much as the server.
 *
 * It also means a 700 KB file cannot be looked at *at all*, and a 400 KB one
 * arrives as thirty thousand table rows in a single document - which is the one
 * failure mode the diff engine exists to avoid, sitting untouched on the other
 * half of the product.
 *
 * So this reads a window. git writes the blob to a pipe, the lines are counted
 * as they go past, and only the ones asked for are kept. Memory is the size of
 * the window, whatever the size of the file; the cost of a late window is
 * reading past what came before it, which is a pipe read and no allocation.
 */

import type { ResumeState } from './resume'
import { isSafeRevision, runGit, spawnGitLimited } from '../Git/git'
import { ScopeWalk } from './resume'

/**
 * How many lines a window holds.
 *
 * The same two thousand the diff viewer windows a large file at, and for the
 * same reason: it is comfortably more than a screen at any zoom, so scrolling
 * within a window is free, and small enough that rendering one is not the thing
 * the reader waits for.
 */
export const BLOB_WINDOW_LINES = 2000

/**
 * The most bytes read to answer for a window.
 *
 * Not a limit on what may be *shown* - the window is bounded by its line count,
 * whatever the bytes hold. This bounds the reading: a file this size is a
 * database dump or a binary that slipped past the NUL check, and neither is
 * something to spend a minute of a server's time streaming past.
 */
export const MAX_WINDOWED_BYTES = 64 * 1024 * 1024

export interface BlobWindow {
  /** The lines asked for, in order, without their newlines. */
  lines: string[]
  /**
   * Where the tokenizer stood at the window's first line, when it could be
   * worked out.
   *
   * A window starting at line 20,000 tokenized from a cold state gets every
   * multi-line construct wrong - a window inside a licence header renders as
   * code - and the lines that would fix it are the ones this reader walks past
   * and drops. Walking them is not free, but it is free of *memory*, which is
   * the property this whole file exists for: the scope stack is a few frames
   * whatever the size of the prelude.
   *
   * Null when there was nothing to resume from: the first window, no language,
   * or a prelude past `MAX_PRELUDE_LINES`.
   */
  resume: ResumeState
  /** The 1-based number of the first line in `lines`. */
  from: number
  /** How many lines the file has in total. */
  total: number
  /** The file's size in bytes, for the header line. */
  size: number
  /** True when the file was not read because it is enormous. */
  tooLarge: boolean
  /** True when a NUL byte appeared, which is git's own heuristic for binary. */
  binary: boolean
  error: string | null
}

/**
 * Clamp a requested range to a file that exists.
 *
 * Pure, because every interesting case is arithmetic at an edge: a range that
 * starts past the end, one that ends past it, one that asks for nothing, and
 * the request with no numbers at all which means "the first window". An
 * implementation that trusts the query string renders an empty table for a file
 * that is plainly there, which reads as the file being empty.
 */
export function blobWindowFor(total: number, from?: number, count?: number): { from: number, to: number } {
  const lines = Math.max(0, Math.floor(total))
  if (lines === 0)
    return { from: 1, to: 0 }

  const size = Math.min(
    Math.max(1, Math.floor(count ?? BLOB_WINDOW_LINES)),
    BLOB_WINDOW_LINES,
  )

  /*
   * A start past the end lands on the last *window*, not on the last line.
   *
   * A stale link to line 40,000 of a file that is now 12,000 long should show
   * the end of the file, and one line of it is not a page - it is an answer
   * that looks like the file is one line long.
   */
  const last = Math.max(1, lines - size + 1)
  const start = Math.min(Math.max(1, Math.floor(from ?? 1)), last)

  return { from: start, to: Math.min(lines, start + size - 1) }
}

/**
 * The size of a blob at a ref, or null when there is no such file.
 *
 * Asked separately and first, because it is the cheap question: git reads an
 * object header rather than the object.
 */
export async function blobSize(repositoryPath: string, ref: string, path: string): Promise<number | null> {
  if (!isSafeRevision(ref) || !path || path.startsWith('-'))
    return null

  const result = await runGit(repositoryPath, ['cat-file', '-s', `${ref}:${path}`])
  if (!result.ok)
    return null

  const size = Number(result.stdout.trim())

  return Number.isFinite(size) ? size : null
}

/**
 * Read one window of a file, and count the rest.
 *
 * One pass. Lines before the window are counted and dropped, lines inside it
 * are kept, and lines after it are counted - because the total is what the
 * scrollbar and the "showing 1-2,000 of 41,988" are made of, and a total that
 * required a second read would mean reading the file twice to show a screen of
 * it.
 */
export async function readBlobWindow(
  repositoryPath: string,
  ref: string,
  path: string,
  request: { from?: number, count?: number, language?: string | null } = {},
): Promise<BlobWindow> {
  const empty = { lines: [], from: 1, total: 0, size: 0, tooLarge: false, binary: false, resume: null }

  if (!isSafeRevision(ref) || !path || path.startsWith('-'))
    return { ...empty, error: 'Invalid ref' }

  const byteSize = await blobSize(repositoryPath, ref, path)
  if (byteSize == null)
    return { ...empty, error: 'No such file at that ref' }

  if (byteSize > MAX_WINDOWED_BYTES)
    return { ...empty, size: byteSize, tooLarge: true, error: null }

  const wanted = {
    from: Math.max(1, Math.floor(request.from ?? 1)),
    count: Math.min(Math.max(1, Math.floor(request.count ?? BLOB_WINDOW_LINES)), BLOB_WINDOW_LINES),
  }

  // Under the process ceiling like every other git spawn. A reader paging
  // through a large file is `interactive`: brief, and somebody is waiting.
  const child = await spawnGitLimited('interactive', repositoryPath, ['cat-file', 'blob', `${ref}:${path}`])

  if (!child)
    return { ...empty, error: 'The server is busy. Try again shortly.' }

  const kept: string[] = []

  /*
   * The last window's worth of lines, always, in a ring.
   *
   * A request that starts past the end has to be answered with the end - a
   * reader who followed a stale link to line 40,000 of a file that is now
   * 12,000 long should land on its last page, not on an empty table that reads
   * as an empty file. The total is only known once the file has been read, so
   * by the time the request could be clamped the lines it wanted have gone
   * past; keeping them costs one assignment per line and no second read of a
   * file that may be sixty megabytes.
   */
  const ring: string[] = new Array(wanted.count)

  let carry = ''
  let seen = 0
  let binary = false

  /*
   * The scope stack at the window's first line, built out of the lines this
   * reader is throwing away anyway.
   *
   * Only fed while `seen` is below the window, so it costs nothing once the
   * window has been reached, and nothing at all for the first window or for a
   * caller that named no language. It is deliberately not fed the *ring*: a
   * request that lands past the end of the file is answered with the last
   * window, and the prelude for that window went past long before anybody knew
   * which window it was. That case resumes cold, which is what it did before.
   */
  const walk = new ScopeWalk(wanted.from > 1 ? (request.language ?? null) : null)

  const take = (line: string): void => {
    seen += 1
    if (seen < wanted.from)
      walk.push(line)
    else if (kept.length < wanted.count)
      kept.push(line)

    ring[(seen - 1) % wanted.count] = line
  }

  // `close` rather than `exit`, so a failure's reason has been read by the time
  // this resolves.
  const done = new Promise<number>((settle) => {
    child.on('error', () => settle(-1))
    child.on('close', code => settle(code ?? -1))
  })

  // A StringDecoder under the hood, so a multi-byte character split across two
  // reads arrives whole rather than as two replacement characters - which in a
  // file being read for review would be two characters that are not in it.
  child.stdout.setEncoding('utf8')

  try {
    // Node readables apply backpressure through the iterator, so git is slowed
    // by a slow reader rather than filling memory with what nobody has taken.
    for await (const chunk of child.stdout) {
      const text = carry + (chunk as string)

      if (!binary && text.includes('\0'))
        binary = true

      const parts = text.split('\n')
      // The last piece has no newline yet: it is either the start of the next
      // line or the file's final line, and only the end of the stream says
      // which.
      carry = parts.pop() ?? ''

      for (const line of parts)
        take(line)
    }
  }
  catch {
    child.kill('SIGKILL')
    return { ...empty, size: byteSize, error: 'Could not read file' }
  }

  // A trailing newline leaves an empty carry, and that is not a line: a file
  // ending `b\n` has two lines, not three.
  if (carry !== '')
    take(carry)

  if (await done !== 0)
    return { ...empty, size: byteSize, error: 'Could not read file' }

  if (binary)
    return { ...empty, size: byteSize, binary: true, error: null }

  // Asked for a window that starts past the end: answer with the last one.
  if (kept.length === 0 && seen > 0) {
    const size = Math.min(wanted.count, seen)
    const first = seen - size

    for (let index = 0; index < size; index++)
      kept.push(ring[(first + index) % wanted.count]!)

    return { lines: kept, from: first + 1, total: seen, size: byteSize, tooLarge: false, binary: false, resume: null, error: null }
  }

  const window = blobWindowFor(seen, wanted.from, wanted.count)

  return {
    lines: kept,
    from: window.from,
    total: seen,
    size: byteSize,
    tooLarge: false,
    binary: false,
    resume: walk.finish(),
    error: null,
  }
}
