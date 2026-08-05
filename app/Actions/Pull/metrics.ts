/**
 * How tall a file's diff will be, worked out without rendering it.
 *
 * This is what makes a virtualized list possible. The reader gets a scrollbar
 * that means something the instant the manifest lands, and jumping to file
 * 9,000 lands on file 9,000, because the list knows every file's height before
 * any of them has been mounted or measured.
 *
 * The counting is exact rather than estimated: a rendered row corresponds to a
 * parsed line, so the arithmetic here and the renderer cannot drift as long as
 * both agree on the rules below. The only estimate is the pixels, which come
 * from a measured line height the client refines once it has mounted anything.
 *
 * Pure over parsed metadata, so the awkward shapes are testable without a DOM.
 */

import type { DiffFile } from './diff'

export interface RowCounts {
  /**
   * Rows in unified layout: one per line, plus one separator per hunk.
   *
   * The separator is the `@@` row carrying the hunk heading and the controls
   * for expanding hidden context, so it occupies a row like any other.
   */
  unified: number
  /**
   * Rows in split layout.
   *
   * A run of changed lines occupies `max(removed, added)` rows rather than
   * `removed + added`, because the two sides sit beside each other and the
   * shorter one is padded. This is why the two counts differ, and why a
   * layout switch has to re-lay-out the list rather than reuse the offsets.
   */
  split: number
}

/** A file with nothing to lay out line by line still occupies one row. */
const NOTE_ROWS = 1

/**
 * Count the rows a file's diff renders as, in both layouts.
 *
 * Both are computed in one pass because the client can switch layout at any
 * time and asking the server again for the other number would be a round trip
 * to learn something already in hand.
 */
export function countRows(file: DiffFile): RowCounts {
  // A binary file, a pure mode change, and a rename with no content change all
  // render as a single explanatory row in either layout.
  if (file.binary || file.hunks.length === 0)
    return { unified: NOTE_ROWS, split: NOTE_ROWS }

  let unified = 0
  let split = 0

  for (const hunk of file.hunks) {
    unified += 1
    split += 1

    // Removals and additions pair up across the two columns, so a change block
    // is as tall as its taller side. Counted over a maximal run of non-context
    // lines, which is what git emits and what the renderer pairs.
    let removed = 0
    let added = 0

    const flush = () => {
      split += Math.max(removed, added)
      removed = 0
      added = 0
    }

    for (const line of hunk.lines) {
      unified += 1

      if (line.origin === 'context') {
        flush()
        split += 1
      }
      else if (line.origin === 'removed') {
        removed += 1
      }
      else {
        added += 1
      }
    }

    flush()
  }

  return { unified, split }
}

export interface HeightMetrics {
  /** One rendered row. Refined by the client once it has measured a real one. */
  lineHeight: number
  /** The sticky file header. */
  headerHeight: number
  /** Space between two files in the list. */
  gap: number
}

/**
 * Starting numbers, in CSS pixels at the default type scale.
 *
 * Deliberately a little generous: an estimate that is too small makes the list
 * shorter than its contents and the scrollbar jumps outward as items mount,
 * which reads as the page fighting the reader. Too large settles inward, which
 * nobody notices.
 */
export const DEFAULT_HEIGHT_METRICS: HeightMetrics = {
  lineHeight: 20,
  // Measured in a browser rather than guessed: a file's header renders at 61
  // pixels with the stylesheet this application ships. It was 40, which is
  // twenty one pixels short per file - unnoticeable on a pull request and
  // eight hundred thousand pixels of lying scrollbar on a forty thousand file
  // compare, where almost every file is estimated and never measured.
  headerHeight: 61,
  gap: 8,
}

export interface EstimateOptions {
  layout?: 'unified' | 'split'
  collapsed?: boolean
  metrics?: HeightMetrics
}

/** The height one file occupies, header included. */
export function estimateFileHeight(rows: RowCounts, options: EstimateOptions = {}): number {
  const { layout = 'unified', collapsed = false, metrics = DEFAULT_HEIGHT_METRICS } = options

  if (collapsed)
    return metrics.headerHeight

  const count = layout === 'split' ? rows.split : rows.unified
  return metrics.headerHeight + count * metrics.lineHeight
}

export interface ListLayout {
  /** The top of each file, in order, measured from the top of the list. */
  offsets: number[]
  /** The height of each file, in the same order. */
  heights: number[]
  /** The height of the whole list, which is what the scrollbar is sized from. */
  total: number
}

/**
 * Lay every file out end to end.
 *
 * Returns offsets as well as heights because the two questions a virtualizer
 * asks are "how tall is the list" and "which files cover this scroll range",
 * and answering the second from heights alone is a linear scan per frame.
 *
 * A parallel array rather than an array of objects: this is allocated per
 * layout change on lists of tens of thousands of files, and it is read on every
 * scroll frame.
 */
export function layoutList(
  rows: readonly RowCounts[],
  options: EstimateOptions & { collapsedAt?: (index: number) => boolean } = {},
): ListLayout {
  const { metrics = DEFAULT_HEIGHT_METRICS, collapsedAt } = options
  const offsets: number[] = new Array(rows.length)
  const heights: number[] = new Array(rows.length)
  let top = 0

  for (let index = 0; index < rows.length; index++) {
    const height = estimateFileHeight(rows[index]!, {
      ...options,
      collapsed: collapsedAt ? collapsedAt(index) : options.collapsed,
    })

    offsets[index] = top
    heights[index] = height
    top += height + metrics.gap
  }

  // The gap goes between files, so the last one does not add a trailing space.
  return { offsets, heights, total: rows.length === 0 ? 0 : top - metrics.gap }
}

/**
 * The first index whose file is still visible at `scrollTop`.
 *
 * Binary search over the offsets, so finding the window costs log(files) rather
 * than a walk. On a 40,000 file compare that is the difference between 16 steps
 * and 40,000 per scroll frame.
 */
export function findIndexAt(layout: ListLayout, scrollTop: number): number {
  const { offsets } = layout
  if (offsets.length === 0)
    return 0

  let low = 0
  let high = offsets.length - 1

  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle]! <= scrollTop)
      low = middle
    else
      high = middle - 1
  }

  return low
}

/**
 * The range of files covering a viewport, with overscan either side.
 *
 * `end` is exclusive. Overscan is in pixels rather than items because items
 * vary by three orders of magnitude in height, and a fixed item count either
 * renders nothing useful above a large file or far too much above small ones.
 */
export function visibleRange(
  layout: ListLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { start: number, end: number } {
  const { offsets } = layout
  if (offsets.length === 0)
    return { start: 0, end: 0 }

  const top = Math.max(0, scrollTop - overscan)
  const bottom = scrollTop + viewportHeight + overscan

  const start = findIndexAt(layout, top)

  let end = start
  while (end < offsets.length && offsets[end]! < bottom)
    end += 1

  // A file taller than the viewport plus its overscan leaves no offset below
  // `bottom`, and `end` would equal `start`: the one file covering the whole
  // screen would not be rendered.
  if (end === start)
    end = start + 1

  return { start, end }
}
