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

/**
 * An item in the list, addressed by what it *is* rather than by where it sits.
 *
 * Everything else in this file works on positions, which is right for a frame -
 * a scroll is arithmetic over offsets - and wrong for a *change*. A list
 * addressed only by position says that the third item is the third item, so
 * inserting one at the top silently renames every item below it: the host
 * mounted for `src/app.ts` now belongs to `src/api.ts`, its measured height
 * belongs to neither, and the reader's anchor points at whatever moved into
 * the slot they were reading.
 *
 * Appending cannot show this, and appending is all a manifest stream does,
 * which is why the list has got this far without identity. A re-fetch does not
 * append: "since I last looked" answers with a different set of files, a push
 * arriving mid-review changes which files exist, and a filter shows a subset.
 * All three are the same shape and all three are wrong by a whole file today.
 *
 * `version` is the other half. Identity says *this is the same item*; version
 * says *and it has changed since you rendered it* - a fold opened, the rows
 * arrived after the record, a comment landed. Without it the only way to know
 * is to re-render everything, which throws away every measured height, or to
 * ask each caller to remember to invalidate, which is the same bug waiting for
 * the next caller.
 */
export interface ListItem extends ViewportFile {
  /**
   * Stable for the life of one item. A file's path, in this product: it
   * survives a rename arriving late in a stream, because a rename reports the
   * *new* path and carries the old one alongside it.
   */
  id: string
  /** Bumped by whoever changes the item. Equal means "what you rendered is still right". */
  version: number
}

export interface ReconcilePlan {
  /** Mounted hosts that survive, and where they move to. `from` and `to` may be equal. */
  keep: Array<{ from: number, to: number }>
  /**
   * Mounted items that are still here and are no longer what was rendered.
   * The host stays and moves with them; its contents do not.
   */
  rerender: Array<{ from: number, to: number }>
  /** Old indexes whose item is gone. Their hosts go back to the pool. */
  release: number[]
  /** The mounted set, translated to the new list. What the next frame plans against. */
  mounted: Set<number>
  /**
   * Measurements carried across, aligned to the new list.
   *
   * Carried where the version is unchanged, dropped where it is not: what was
   * measured was the other content, and a stale measurement is worse than an
   * estimate because the estimate at least knows the row count.
   */
  measured: Array<number | undefined>
  /**
   * The reader's anchor, moved to wherever its item went.
   *
   * Null when the item they were reading is not in the new list at all, which
   * is the one case where there is nothing honest to do but let the caller
   * decide - the alternative is landing them at the same *position*, which is
   * a different file with the same index and looks like the page jumped.
   */
  anchor: ScrollAnchor | null
}

/**
 * What changes when the list itself changes.
 *
 * Pure, and separated from the frame planning above for the same reason
 * everything else here is: the failures are off-by-one and they are invisible
 * in a screenshot. A host that keeps its element but shows another file's rows
 * looks exactly like a correct render of the wrong thing.
 *
 * Duplicate ids are resolved by first occurrence, in list order, and the later
 * one is treated as a new item. Ids are the caller's to keep unique - a diff
 * cannot contain one path twice - and a plan that threw here would turn a
 * cosmetic mistake into a blank page.
 */
export function reconcileList(
  previous: readonly ListItem[],
  next: readonly ListItem[],
  state: { mounted?: ReadonlySet<number>, anchor?: ScrollAnchor | null } = {},
): ReconcilePlan {
  const mounted = state.mounted ?? new Set<number>()
  const anchor = state.anchor ?? null

  const previousById = new Map<string, number>()
  for (let index = 0; index < previous.length; index++) {
    if (!previousById.has(previous[index]!.id))
      previousById.set(previous[index]!.id, index)
  }

  const keep: Array<{ from: number, to: number }> = []
  const rerender: Array<{ from: number, to: number }> = []
  const nextMounted = new Set<number>()
  const measured: Array<number | undefined> = new Array(next.length)
  const survived = new Set<number>()
  const seen = new Set<string>()

  for (let to = 0; to < next.length; to++) {
    const item = next[to]!
    if (seen.has(item.id))
      continue

    seen.add(item.id)

    const from = previousById.get(item.id)
    if (from == null)
      continue

    survived.add(from)

    const unchanged = previous[from]!.version === item.version
    // The item's own measurement wins if it brought one; otherwise inherit what
    // the previous list had measured for it, which is the whole point.
    measured[to] = item.measured ?? (unchanged ? previous[from]!.measured : undefined)

    if (!mounted.has(from))
      continue

    nextMounted.add(to)

    if (unchanged)
      keep.push({ from, to })
    else
      rerender.push({ from, to })
  }

  const release: number[] = []
  for (const index of mounted) {
    if (!survived.has(index))
      release.push(index)
  }

  release.sort((a, b) => a - b)

  return {
    keep,
    rerender,
    release,
    mounted: nextMounted,
    measured,
    anchor: movedAnchor(previous, next, anchor),
  }
}

/**
 * The anchor, following its item rather than its index.
 *
 * The offset inside the item is kept as it was: the reader is a certain
 * distance into a file, and that is true wherever the file has moved to. It
 * gets clamped to the item's height later, by `restoreAnchor`, which is where
 * the new layout is known.
 */
function movedAnchor(
  previous: readonly ListItem[],
  next: readonly ListItem[],
  anchor: ScrollAnchor | null,
): ScrollAnchor | null {
  if (anchor == null)
    return null

  const item = previous[anchor.index]
  if (!item)
    return null

  const to = next.findIndex(candidate => candidate.id === item.id)

  return to === -1 ? null : { index: to, offset: anchor.offset }
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

/** Where in the viewport a scroll target should come to rest. */
export type ScrollAlignment = 'start' | 'center' | 'end'

export interface ScrollTarget {
  /** The file, by position in the list. */
  index: number
  /**
   * How far into that file, in pixels.
   *
   * For a line rather than a file. The caller works this out from a mounted
   * row's offset, which is the only place the answer actually exists: a line's
   * height depends on wrapping, on the layout, and on whether a thread is
   * sitting under it.
   */
  offset?: number
  alignment?: ScrollAlignment
  /** Extra room above the target, for a sticky header sitting over it. */
  headerOffset?: number
}

/**
 * The scroll position that brings a target into view.
 *
 * Pure, and clamped to the scrollable range, so the caller writing it does not
 * have to know how tall the list is. Clamping here rather than in the caller is
 * what stops a scroll to the last file of a diff from asking for a position
 * past the end and having the browser quietly land somewhere else - which is
 * the shape of every "it scrolled nearly to the right place" bug.
 */
export function scrollTargetFor(
  layout: ListLayout,
  viewportHeight: number,
  target: ScrollTarget,
): number | null {
  const top = layout.offsets[target.index]
  const height = layout.heights[target.index]
  if (top == null || height == null)
    return null

  const at = top + (target.offset ?? 0)
  const alignment = target.alignment ?? 'start'
  // Only meaningful for a whole file. A line has no height here, so centring
  // one centres its top edge, which is what a reader means by it anyway.
  const size = target.offset == null ? height : 0

  let position = at - (target.headerOffset ?? 0)

  if (alignment === 'center')
    position = at - Math.max(0, (viewportHeight - size) / 2)
  else if (alignment === 'end')
    position = at + size - viewportHeight

  const furthest = Math.max(0, layout.total - viewportHeight)

  return Math.max(0, Math.min(position, furthest))
}

/**
 * Whether to animate a scroll.
 *
 * `prefers-reduced-motion` is not a preference about decoration: for some
 * readers a smooth scroll of several thousand pixels is nausea. Asked at the
 * moment of scrolling rather than captured at startup, because it can change
 * while the page is open.
 */
export function scrollBehaviourFor(smooth: boolean, prefersReducedMotion: boolean): ScrollBehavior {
  return smooth && !prefersReducedMotion ? 'smooth' : 'auto'
}
