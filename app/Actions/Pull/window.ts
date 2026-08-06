/**
 * Which rows of a very large file belong on screen.
 *
 * The list virtualizes *files*: forty thousand files mount a screenful, which
 * is the whole point of it. A single file of four hundred thousand lines is the
 * shape that arrangement has nothing to say about - it is one item, so it
 * mounts whole, and four hundred thousand table rows in one document is the
 * failure this engine exists to avoid.
 *
 * So a file over a threshold is windowed in turn: the browser holds a range of
 * its rows and two spacers standing in for the rest, and asks for a new range
 * as the reader moves. Everything here is arithmetic over numbers, tested
 * without a DOM, for the same reason the rest of the viewport module is.
 *
 * The row *index* is the unit throughout, and it is the same index `countRows`
 * counts and `renderDiffRows` emits. That is not a coincidence to be maintained
 * by hand: if the two drifted, every window would be off by a line.
 */

/**
 * Rows past which a file is windowed rather than mounted whole.
 *
 * Below it, sending and mounting the file entire is simpler and cheaper than
 * two spacers and a round trip - a two thousand row file is about forty
 * screens, which a browser lays out without complaint. Above it, the cost
 * stops being worth paying for content nobody has scrolled to.
 */
export const WINDOW_ABOVE_ROWS = 2_000

/** Rows fetched at a time. A few screens, so a scroll does not outrun it. */
export const WINDOW_ROWS = 600

/**
 * How close to an edge the reader gets before the next window is fetched.
 *
 * A quarter of a window. Smaller and a steady scroll reaches the edge before
 * the reply lands; larger and every small movement near the middle refetches.
 */
export const WINDOW_MARGIN_ROWS = 150

export interface RowWindow {
  from: number
  to: number
}

/** Whether a file is large enough to be worth windowing. */
export function shouldWindow(totalRows: number, threshold = WINDOW_ABOVE_ROWS): boolean {
  return totalRows > threshold
}

/**
 * The rows visible within a file, given where the viewport sits over it.
 *
 * `fileTop` is where the file's first row starts in the list's coordinates -
 * the file's offset plus its header - so this is pure arithmetic and knows
 * nothing about elements.
 */
export function visibleRows(options: {
  scrollTop: number
  viewportHeight: number
  fileTop: number
  totalRows: number
  rowHeight: number
}): RowWindow {
  const { scrollTop, viewportHeight, fileTop, totalRows, rowHeight } = options

  if (!(rowHeight > 0) || totalRows <= 0)
    return { from: 0, to: 0 }

  const first = Math.floor((scrollTop - fileTop) / rowHeight)
  const last = Math.ceil((scrollTop + viewportHeight - fileTop) / rowHeight)

  return {
    from: Math.max(0, Math.min(first, totalRows)),
    to: Math.max(0, Math.min(last, totalRows)),
  }
}

/**
 * The window to fetch so the visible rows are covered with room either side.
 *
 * Aligned to a grid of `WINDOW_ROWS`, which is what stops a slow scroll from
 * asking for a slightly different range on every frame: the answer only changes
 * when the reader crosses a boundary, so the same request is not made sixty
 * times with the numbers nudged by one.
 */
export function windowFor(visible: RowWindow, totalRows: number, size = WINDOW_ROWS): RowWindow {
  if (totalRows <= 0)
    return { from: 0, to: 0 }

  const centre = Math.floor((visible.from + visible.to) / 2)
  const start = Math.max(0, Math.floor((centre - size / 2) / size) * size)

  return { from: start, to: Math.min(totalRows, start + size * 2) }
}

/**
 * Whether the window in hand still covers what the reader can see.
 *
 * The margin is the point: refetching only when the visible rows have already
 * left the window means the reader sees a blank band first. Asking while they
 * are still a margin from the edge means the reply is usually there before they
 * arrive.
 */
export function needsWindow(
  held: RowWindow | null,
  visible: RowWindow,
  totalRows: number,
  margin = WINDOW_MARGIN_ROWS,
): boolean {
  if (held == null)
    return true

  // Nothing to fetch past the ends of the file, so an edge that is the file's
  // own edge is never too close.
  const roomAbove = held.from === 0 || visible.from - held.from >= margin
  const roomBelow = held.to >= totalRows || held.to - visible.to >= margin

  return !roomAbove || !roomBelow
}

/**
 * The two spacer heights that stand in for the rows not in the document.
 *
 * A spacer rather than nothing, because the scrollbar has to mean something:
 * without them a windowed file would be as tall as its window and the reader
 * would reach the end of a hundred thousand line file in four screens.
 */
export function spacers(held: RowWindow, totalRows: number, rowHeight: number): { above: number, below: number } {
  const above = Math.max(0, held.from) * rowHeight
  const below = Math.max(0, totalRows - held.to) * rowHeight

  return { above, below }
}
