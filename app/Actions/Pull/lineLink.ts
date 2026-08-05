/**
 * Linking to a line.
 *
 * "Have a look at this" with a URL under it is most of what review is, and a
 * link that lands on the file and leaves the reader to find the line is a link
 * that made them do the work twice.
 *
 * The form is `#path:side:line` or `#path:side:from-to` for a range, with the
 * path last-escaped rather than first, because a path can contain a colon on
 * every filesystem this runs on and a naive split would cut it in the wrong
 * place.
 */

export type LineSide = 'left' | 'right'

export interface LineAnchor {
  path: string
  side: LineSide
  /** First line of the selection, 1-based. */
  from: number
  /** Last line, inclusive. The same as `from` for a single line. */
  to: number
}

/**
 * The fragment for an anchor.
 *
 * The path is percent-encoded, so the two colons that follow it are the only
 * unescaped ones and parsing can work backwards from the end.
 */
export function formatLineAnchor(anchor: LineAnchor): string {
  const range = anchor.to > anchor.from ? `${anchor.from}-${anchor.to}` : String(anchor.from)
  return `#${encodeURIComponent(anchor.path)}:${anchor.side === 'left' ? 'L' : 'R'}:${range}`
}

/**
 * Read a fragment back, or null.
 *
 * Null for anything that is not one of ours, because a page may carry other
 * fragments and treating a stranger's as a broken anchor of ours would scroll
 * the reader somewhere arbitrary.
 */
export function parseLineAnchor(hash: string): LineAnchor | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (text === '')
    return null

  // From the end: the last two colons separate the side and the range, and
  // everything before them is the encoded path.
  const lastColon = text.lastIndexOf(':')
  const sideColon = text.lastIndexOf(':', lastColon - 1)
  if (lastColon < 0 || sideColon < 0)
    return null

  const rawPath = text.slice(0, sideColon)
  const sideText = text.slice(sideColon + 1, lastColon)
  const rangeText = text.slice(lastColon + 1)

  if (sideText !== 'L' && sideText !== 'R')
    return null

  const match = /^(\d+)(?:-(\d+))?$/.exec(rangeText)
  if (!match)
    return null

  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  if (from < 1 || to < from)
    return null

  let path: string
  try {
    path = decodeURIComponent(rawPath)
  }
  catch {
    return null
  }

  if (path === '')
    return null

  return { path, side: sideText === 'L' ? 'left' : 'right', from, to }
}

/**
 * The anchor covering two clicked lines, in whichever order they were clicked.
 *
 * Shift-clicking above the first line is the ordinary way to extend a selection
 * upwards, and a range that came back inverted would select nothing.
 */
export function anchorBetween(a: LineAnchor, b: LineAnchor): LineAnchor {
  return {
    path: a.path,
    side: a.side,
    from: Math.min(a.from, b.from),
    to: Math.max(a.to, b.to),
  }
}

/** Whether a line falls inside an anchor. */
export function anchorCovers(anchor: LineAnchor, path: string, side: LineSide, line: number): boolean {
  return anchor.path === path && anchor.side === side && line >= anchor.from && line <= anchor.to
}
