/**
 * A large file, scrolled rather than paged.
 *
 * The server renders one window of a long file and links to the next, which is
 * the whole feature with nothing running: `?from=` is a line number and the
 * links are links. This makes it continuous for a reader who does have a script
 * engine - the rest of the file arrives as they reach it, and the scrollbar
 * describes the file rather than the page.
 *
 * The arithmetic is `app/Actions/Pull/window.ts`, the same module the diff
 * viewer windows a very large file with: which rows are visible, which window
 * covers them with room either side, and whether the one in hand still does.
 * None of it is reimplemented here, so a fix to either surface is a fix to
 * both.
 *
 * What this file adds is the part that touches elements: two spacer rows
 * standing in for what is not mounted, sized so the document's height is the
 * whole file's height at every scroll position. Without them the scrollbar
 * would describe two thousand lines of a forty thousand line file, and reaching
 * the end would keep moving further away.
 */

import { needsWindow, type RowWindow, visibleRows, windowFor } from '../../app/Actions/Pull/window'

/**
 * Rows per request.
 *
 * `windowFor` returns twice its size, and the endpoint answers at most two
 * thousand lines, so this is the largest size whose window the server will
 * serve whole. Asking for more would silently get less and leave the spacers
 * describing rows that never arrived.
 */
const WINDOW_SIZE = 1_000

/**
 * A line number is 1-based; a row index is not. The seam is here, once.
 *
 * Exported because it is the only arithmetic in this file that can be wrong
 * without anything looking wrong: a window off by one fetches lines the spacers
 * do not stand for, and the file scrolls past itself by a line per window.
 */
export function linesFor(rows: RowWindow): { from: number, count: number } {
  return { from: rows.from + 1, count: Math.max(1, rows.to - rows.from) }
}

export function mountBlobWindow(): void {
  const table = document.querySelector<HTMLTableElement>('table[data-blob-window]')
  const body = table?.querySelector('tbody')
  if (!table || !body)
    return

  const total = Number(table.dataset.total ?? '0')
  const rowsUrl = String(table.dataset.rowsUrl ?? '')
  if (!rowsUrl || !(total > 0))
    return

  const held: RowWindow = {
    from: Number(table.dataset.from ?? '1') - 1,
    to: Number(table.dataset.from ?? '1') - 1 + body.querySelectorAll('tr.source-row').length,
  }

  // Nothing to fetch: the file arrived whole.
  if (held.to >= total && held.from === 0)
    return

  const notice = document.querySelector<HTMLElement>('.file-window')
  const nav = document.querySelector<HTMLElement>('.file-window-nav')

  /*
   * The links go, and only once this is running.
   *
   * They are the no-script path and they are correct; leaving them under a list
   * that now extends itself would be two ways to move through one file, one of
   * which reloads the page and loses the reader's place.
   */
  if (nav)
    nav.hidden = true

  let rowHeight = 0
  let pending: RowWindow | null = null
  let frame: number | null = null

  function measureRowHeight(): number {
    const row = body!.querySelector<HTMLElement>('tr.source-row')

    return row ? row.getBoundingClientRect().height : 0
  }

  function spacer(rows: number): string {
    return rows > 0
      ? `<tr class="row-spacer" aria-hidden="true"><td colspan="2" style="height:${Math.round(rows * rowHeight)}px;padding:0"></td></tr>`
      : ''
  }

  /**
   * Where the file's *first* line sits in the document.
   *
   * The body's own top, and not adjusted for the window in hand: the spacer
   * above the held rows is exactly as tall as the rows it stands in for, so the
   * top of the body is where line one would be if it were mounted. That is the
   * coordinate the arithmetic is in, and it is why the spacers have to be sized
   * from the same row height the window is chosen with.
   */
  function fileTop(): number {
    return body!.getBoundingClientRect().top + window.scrollY
  }

  function paint(rows: string, range: RowWindow): void {
    // Written in one assignment: replacing the rows and both spacers together
    // means the document's height never passes through a wrong value, so the
    // browser has nothing to scroll-correct against.
    body!.innerHTML = spacer(range.from) + rows + spacer(Math.max(0, total - range.to))

    held.from = range.from
    held.to = range.to

    if (notice)
      notice.textContent = `Lines ${(range.from + 1).toLocaleString()}–${range.to.toLocaleString()} of ${total.toLocaleString()}`
  }

  async function fetchWindow(wanted: RowWindow): Promise<void> {
    const { from, count } = linesFor(wanted)

    try {
      const answer = await fetch(`${rowsUrl}&from=${from}&count=${count}`, {
        headers: { Accept: 'application/json' },
      })

      if (!answer.ok)
        return

      const record = await answer.json() as { from?: number, to?: number, rows?: string }
      if (typeof record.rows !== 'string' || typeof record.from !== 'number' || typeof record.to !== 'number')
        return

      // The server's own answer, not what was asked for: a request near the end
      // is pulled back to the last window, and painting the requested range
      // against the returned rows would size the spacers for lines that are not
      // there.
      paint(record.rows, { from: record.from - 1, to: record.to })
    }
    catch {
      // The window that is up stays up. A file the reader is halfway through is
      // not improved by replacing it with an error.
    }
    finally {
      pending = null
    }
  }

  function check(): void {
    frame = null

    if (pending)
      return

    if (!(rowHeight > 0)) {
      rowHeight = measureRowHeight()
      if (!(rowHeight > 0))
        return

      // The first paint the reader did not ask for: the rows are already right,
      // and this is what gives the document the height of the whole file.
      paint(body!.innerHTML.replace(/<tr class="row-spacer"[\s\S]*?<\/tr>/g, ''), { ...held })
    }

    const visible = visibleRows({
      scrollTop: window.scrollY,
      viewportHeight: window.innerHeight,
      fileTop: fileTop(),
      totalRows: total,
      rowHeight,
    })

    if (!needsWindow(held, visible, total))
      return

    const wanted = windowFor(visible, total, WINDOW_SIZE)
    pending = wanted
    void fetchWindow(wanted)
  }

  function schedule(): void {
    if (frame == null)
      frame = requestAnimationFrame(check)
  }

  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule, { passive: true })
  schedule()
}
