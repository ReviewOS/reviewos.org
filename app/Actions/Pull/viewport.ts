/**
 * The decisions a virtualized list makes, separated from the DOM it makes them
 * about.
 *
 * Everything here is arithmetic over numbers: which files should be mounted,
 * which should be released, where the scroll position has to move so the
 * reader's place survives a change, and how measured heights replace estimated
 * ones. None of it touches an element.
 *
 * That separation is not tidiness. A virtualizer is easy to get subtly wrong -
 * an off-by-one at the window edge, an anchor that drifts a pixel per relayout,
 * a reconcile that unmounts and remounts the same file every frame - and every
 * one of those is invisible in a screenshot and obvious in a test. The DOM
 * binding in `resources/functions/diffviewer.ts` is the thin part on top.
 */

import type { HeightMetrics, ListLayout, RowCounts } from './metrics'
import { DEFAULT_HEIGHT_METRICS, findIndexAt, layoutList, visibleRange } from './metrics'

export interface ViewportState {
  scrollTop: number
  height: number
}

export interface MountPlan {
  /** Files to mount, in order, so the DOM is appended to rather than reordered. */
  mount: number[]
  /** Files to release. Their elements go back to the pool. */
  unmount: number[]
  /** Everything that should be mounted after the plan is applied. */
  next: Set<number>
}

/**
 * What changes between one frame and the next.
 *
 * The important property is that a file already mounted and still in range is
 * in neither list. Rebuilding the mounted set every frame would work and would
 * also throw away every measured height and every open comment box sixty times
 * a second.
 */
export function planMounts(mounted: ReadonlySet<number>, start: number, end: number): MountPlan {
  const next = new Set<number>()
  const mount: number[] = []

  for (let index = start; index < end; index++) {
    next.add(index)
    if (!mounted.has(index))
      mount.push(index)
  }

  const unmount: number[] = []
  for (const index of mounted) {
    if (!next.has(index))
      unmount.push(index)
  }

  // Ascending, so a caller releasing elements walks the DOM in one direction.
  unmount.sort((a, b) => a - b)

  return { mount, unmount, next }
}

export interface ScrollAnchor {
  /** The file the reader is looking at. */
  index: number
  /** How far into that file the top of the viewport sits. */
  offset: number
}

/**
 * What the reader is looking at, so it can be put back afterwards.
 *
 * Taken before a change that moves things (a layout switch, a collapse, a
 * measured height replacing an estimate) and restored after. Without it, a file
 * above the viewport growing by two hundred pixels pushes the passage being
 * read off the screen, which is the single most irritating thing a diff viewer
 * can do.
 *
 * Anchored to the first *visible* file rather than the nearest one, because a
 * file whose bottom edge is one pixel above the viewport is not what the reader
 * is looking at.
 */
export function captureAnchor(layout: ListLayout, scrollTop: number): ScrollAnchor | null {
  if (layout.offsets.length === 0)
    return null

  const index = findIndexAt(layout, scrollTop)
  return { index, offset: scrollTop - layout.offsets[index]! }
}

/**
 * The scroll position that keeps the anchored file where it was.
 *
 * The offset within the file is clamped to the file's new height: a file that
 * collapsed from four hundred pixels to forty cannot still be scrolled three
 * hundred pixels into, and carrying the old offset would jump the reader past
 * several files.
 */
export function restoreAnchor(layout: ListLayout, anchor: ScrollAnchor | null): number {
  if (anchor == null || layout.offsets.length === 0)
    return 0

  const index = Math.min(anchor.index, layout.offsets.length - 1)
  const offset = Math.min(Math.max(anchor.offset, 0), layout.heights[index]!)

  return layout.offsets[index]! + offset
}

/**
 * Snap a scroll position to the device pixel grid.
 *
 * Browsers store `scrollTop` on the device pixel grid, so on a fractional-DPR
 * display (1.25x, 1.5x) an unsnapped target leaves a residual that never
 * settles: the list nudges itself by a fraction of a pixel on every frame and
 * the text shimmers. Read fresh each time so switching monitors or zooming is
 * picked up without a cache to flush.
 */
export function snapToDevicePixel(value: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1
  return Math.round(value * ratio) / ratio
}

export interface ViewportFile {
  rows: RowCounts
  collapsed: boolean
  /**
   * The measured height, once it has been mounted and read.
   *
   * Estimates are honest guesses from row counts. A real height differs because
   * a line wrapped, an annotation was injected, or the type is not the size the
   * metrics assumed. Once measured, it wins.
   */
  measured?: number
}

export interface ViewportOptions {
  layout?: 'unified' | 'split'
  metrics?: HeightMetrics
  /** Pixels rendered above and below the viewport. */
  overscan?: number
}

/**
 * The list's geometry: estimates for what has not been seen, measurements for
 * what has.
 *
 * Recomputed whenever the set of files, the layout, or a measurement changes,
 * which is a linear pass. On a forty thousand file compare that is a fraction
 * of a millisecond and happens far less often than a scroll frame, which is a
 * binary search.
 */
export function measuredLayout(files: readonly ViewportFile[], options: ViewportOptions = {}): ListLayout {
  const { layout = 'unified', metrics = DEFAULT_HEIGHT_METRICS } = options

  const estimated = layoutList(files.map(file => file.rows), {
    layout,
    metrics,
    collapsedAt: index => files[index]!.collapsed,
  })

  // Nothing measured yet, so the estimates stand as they are.
  if (!files.some(file => file.measured != null))
    return estimated

  const offsets: number[] = new Array(files.length)
  const heights: number[] = new Array(files.length)
  let top = 0

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    // Measured wins, collapsed or not.
    //
    // It did not used to: a collapsed file kept its estimate however tall it
    // measured, because the markup for a collapsed file still contained every
    // row and was merely hidden, so what it measured was the open height. A
    // collapsed file is now rendered as its header alone, so the measurement is
    // the header - which is the one number worth having, since the estimate for
    // a header is a constant somebody guessed.
    const height = file.measured ?? estimated.heights[index]!

    offsets[index] = top
    heights[index] = height
    top += height + metrics.gap
  }

  return { offsets, heights, total: files.length === 0 ? 0 : top - metrics.gap }
}

export interface FrameResult {
  layout: ListLayout
  plan: MountPlan
  /** Set when the reader's position had to be corrected. */
  scrollTop?: number
}

/**
 * Work out one frame.
 *
 * The whole per-frame decision in one pure call: where everything is, what
 * should be on screen, and whether the scroll position needs correcting. The
 * DOM layer applies the result and reports back any heights it measured.
 */
export function planFrame(
  files: readonly ViewportFile[],
  mounted: ReadonlySet<number>,
  viewport: ViewportState,
  options: ViewportOptions & { anchor?: ScrollAnchor | null, devicePixelRatio?: number } = {},
): FrameResult {
  const { overscan = DEFAULT_OVERSCAN, anchor, devicePixelRatio = 1 } = options
  const layout = measuredLayout(files, options)

  let scrollTop = viewport.scrollTop
  let corrected: number | undefined

  if (anchor != null) {
    const restored = snapToDevicePixel(restoreAnchor(layout, anchor), devicePixelRatio)
    // Only reported when it actually moves, so the caller is not writing
    // scrollTop on every frame and fighting the reader's own scrolling.
    if (Math.abs(restored - scrollTop) > 0.5) {
      scrollTop = restored
      corrected = restored
    }
  }

  const { start, end } = visibleRange(layout, scrollTop, viewport.height, overscan)

  return { layout, plan: planMounts(mounted, start, end), scrollTop: corrected }
}

/**
 * Pixels rendered either side of the viewport.
 *
 * Enough that a fast scroll does not outrun the mounting, and not so much that
 * a list of small files mounts hundreds of them. A thousand is roughly two
 * screens on a laptop; below about eight hundred, Safari shows blank bands
 * during a flung scroll because it paints before the mount lands.
 */
export const DEFAULT_OVERSCAN = 1000
