/**
 * The lines a diff left out.
 *
 * A hunk shows three lines of context either side, which is enough to know
 * where you are and rarely enough to know whether a change is right. The
 * function being modified starts eight lines up; the early return that makes
 * the new branch unreachable is twelve lines down. Neither is in the patch, and
 * a reviewer who wants them has to leave the review.
 *
 * So the gaps between hunks are readable on request. The lines come from the
 * blob at the relevant commit rather than from the patch, because the patch
 * does not contain them - that is what makes them a gap.
 */

import type { DiffFile, DiffHunk, DiffLine } from './diff'
import { readBlob } from '../Browse/load'

export interface ExpandRequest {
  /** The file, by the path it has on the side being read. */
  path: string
  /** The commit to read the file at. */
  ref: string
  /** First line wanted, 1-based and inclusive. */
  from: number
  /** Last line wanted, inclusive. */
  to: number
}

export interface ExpandedLines {
  ok: boolean
  /** 1-based line number of the first entry in `lines`. */
  from: number
  lines: string[]
  error: string | null
}

/**
 * How many lines one request may ask for.
 *
 * A gap can be thousands of lines - two hunks at opposite ends of a large file
 * - and rendering all of them is how "show me a bit more" turns into a page
 * that is longer than the diff it was helping with. The reader can ask again.
 */
export const MAX_EXPAND_LINES = 200

/** Read a range of lines out of a file at a commit. */
export async function expandRange(
  repositoryPath: string,
  request: ExpandRequest,
): Promise<ExpandedLines> {
  const from = Math.max(1, Math.floor(request.from))
  const to = Math.floor(request.to)

  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
    return { ok: false, from, lines: [], error: 'That is not a range' }

  const blob = await readBlob(repositoryPath, request.ref, request.path)
  if (!blob.ok || blob.text === null) {
    // A binary or oversized file has no lines to show, and neither does one
    // that is genuinely absent at this commit. All three read the same to a
    // reader asking for context: there is none to give.
    return { ok: false, from, lines: [], error: blob.error ?? 'No context available' }
  }

  const all = splitLines(blob.text)
  const last = Math.min(to, from + MAX_EXPAND_LINES - 1, all.length)

  if (from > all.length)
    return { ok: false, from, lines: [], error: 'That range is past the end of the file' }

  return { ok: true, from, lines: all.slice(from - 1, last), error: null }
}

/**
 * Split a file into lines without inventing a last one.
 *
 * A file ending in a newline splits into a trailing empty string that is not a
 * line of the file, and expanding into it shows a blank row that does not
 * exist.
 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '')
    lines.pop()

  return lines
}

export interface Gap {
  /** The hunk this gap sits above, by index. `hunks.length` means below the last. */
  hunkIndex: number
  /** First and last line of the gap on the new side, inclusive. */
  from: number
  to: number
  /** How many lines are hidden. */
  size: number
}

/**
 * The gaps in a file's diff, on the new side.
 *
 * The new side, because that is the file as it will be once merged, and a
 * reviewer reading for context is reading the version being proposed. A gap
 * above the first hunk and below the last are both included: the top of a file
 * is where the imports are, and the bottom is where a missing export would be.
 */
export function gapsIn(file: DiffFile, totalLines?: number): Gap[] {
  const gaps: Gap[] = []
  let previousEnd = 0

  for (let index = 0; index < file.hunks.length; index++) {
    const hunk = file.hunks[index]!
    const start = hunk.newStart

    if (start > previousEnd + 1) {
      gaps.push({
        hunkIndex: index,
        from: previousEnd + 1,
        to: start - 1,
        size: start - 1 - previousEnd,
      })
    }

    previousEnd = Math.max(previousEnd, hunk.newStart + hunk.newLines - 1)
  }

  // Below the last hunk, when the caller knows how long the file is. Without
  // that it cannot be known from the patch alone, so it is left out rather than
  // guessed at.
  if (totalLines != null && totalLines > previousEnd) {
    gaps.push({
      hunkIndex: file.hunks.length,
      from: previousEnd + 1,
      to: totalLines,
      size: totalLines - previousEnd,
    })
  }

  return gaps
}

/**
 * Turn expanded lines into rows the renderer can place.
 *
 * They are context lines: present on both sides, and numbered on both. The
 * offset between the two sides is whatever the preceding hunk established, so
 * it is passed in rather than recomputed.
 */
export function contextLinesFrom(
  lines: readonly string[],
  firstNewLine: number,
  oldOffset: number,
): DiffLine[] {
  return lines.map((content, index) => ({
    origin: 'context' as const,
    content,
    oldLine: firstNewLine + index - oldOffset,
    newLine: firstNewLine + index,
  }))
}

/**
 * How far the old side trails the new one at a hunk.
 *
 * Every hunk before this one has shifted the two apart by whatever it added
 * minus whatever it removed, and git records both in the header.
 */
export function oldOffsetAt(hunk: DiffHunk): number {
  return hunk.newStart - hunk.oldStart
}
