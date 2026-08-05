/**
 * The virtualized diff list, in the browser.
 *
 * This is the thin half. Every decision it makes - which files belong on
 * screen, where they sit, how far the scroll position has to move to keep the
 * reader's place - is arithmetic that lives in `app/Actions/Pull/viewport.ts`
 * and is tested without a DOM. What is left here is applying those answers to
 * elements, which is the part that cannot be unit tested and therefore should
 * be the part with no decisions in it.
 *
 * What the browser holds, at any size of diff: the manifest (a couple of
 * hundred bytes a file), the elements currently on screen, and nothing else.
 * The patch itself never arrives here. That is the whole reason a viewer with
 * no server has to give up on very large diffs and this one does not.
 *
 * No dependencies, no framework. It is called from a view, not from an stx
 * `<script>` block, which is why it may touch the DOM at all.
 */

import type { ScrollAnchor, ViewportFile } from '../../app/Actions/Pull/viewport'
import type { RowCounts } from '../../app/Actions/Pull/metrics'
import { DEFAULT_HEIGHT_METRICS } from '../../app/Actions/Pull/metrics'
import { captureAnchor, DEFAULT_OVERSCAN, measuredLayout, planFrame } from '../../app/Actions/Pull/viewport'

/**
 * How many hosts to keep for reuse.
 *
 * A screen's worth plus the overscan either side, with room to spare. Beyond
 * that the pool is holding elements nobody is going to ask for.
 */
const POOL_LIMIT = 64

/**
 * A manifest record as the viewer wants it.
 *
 * The wire format calls the position `i`, because it is repeated once per file
 * and a forty thousand file manifest is not the place to spend five characters
 * a line on a name. Renamed once, here at the boundary, rather than leaving
 * every reader of a `DiffFileEntry` to remember which one it is.
 */
function toFileEntry(record: Record<string, unknown>): DiffFileEntry {
  return {
    index: Number(record.i),
    path: String(record.path),
    from: record.from == null ? null : String(record.from),
    status: String(record.status),
    binary: Boolean(record.binary),
    additions: Number(record.additions),
    deletions: Number(record.deletions),
    hunks: Number(record.hunks),
    rows: record.rows as DiffFileEntry['rows'],
    collapsed: Boolean(record.collapsed),
  }
}

/** Where the reader's layout choice is remembered. */
const LAYOUT_KEY = 'reviewos:diff-layout'

/**
 * The layout the reader last chose.
 *
 * Storage can throw: Safari in private browsing, and any browser with
 * third-party storage blocked in a frame. A reader who cannot be remembered
 * still gets a working page, so this never throws.
 */
function readStoredLayout(): 'unified' | 'split' | null {
  try {
    const value = window.localStorage.getItem(LAYOUT_KEY)
    return value === 'split' || value === 'unified' ? value : null
  }
  catch {
    return null
  }
}

function writeStoredLayout(layout: 'unified' | 'split'): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout)
  }
  catch {
    // Not being remembered is not a reason to stop.
  }
}

/** How long a row request waits to collect more files before it goes. */
const ROW_FETCH_DELAY_MS = 32

/** Files per row request. Matches the server's own cap on how many it will take. */
const ROW_FETCH_BATCH = 40

/** Files per batch handed to the viewer. */
const MANIFEST_BATCH_SIZE = 50

/** And the longest a batch waits to be handed over, however few are in it. */
const MANIFEST_BATCH_MS = 100

/** One file, as the manifest describes it. */
export interface DiffFileEntry {
  index: number
  path: string
  from: string | null
  status: string
  binary: boolean
  additions: number
  deletions: number
  hunks: number
  rows: RowCounts
  collapsed: boolean
}

export interface DiffViewerOptions {
  /** The scrolling element. */
  scroller: HTMLElement
  /** The sized element inside it that files are positioned against. */
  content: HTMLElement
  layout?: 'unified' | 'split'
  overscan?: number
  /**
   * Fill a host element with one file.
   *
   * Called when a file comes into range. The host is recycled, so it may hold
   * the markup of a file that has scrolled away; replacing its contents is the
   * implementation's job.
   */
  renderFile: (file: DiffFileEntry, host: HTMLElement) => void
  /** Called before a host is returned to the pool, to release anything attached. */
  releaseFile?: (file: DiffFileEntry, host: HTMLElement) => void
  /** Called after every applied frame, for a caller keeping a file tree in step. */
  onVisibleChange?: (start: number, end: number) => void
}

export interface DiffViewer {
  /** Append files. Safe to call repeatedly while the manifest streams in. */
  addFiles: (files: readonly DiffFileEntry[]) => void
  setLayout: (layout: 'unified' | 'split') => void
  setCollapsed: (index: number, collapsed: boolean) => void
  /**
   * Render a mounted file again.
   *
   * Called when its markup arrives after it was mounted, which is the ordinary
   * case while streaming: the file record comes first and is laid out
   * immediately, and the rows follow. Without this the placeholder that stood
   * in for them stays there forever.
   */
  refresh: (index: number) => void
  /**
   * Measure a file again, because something changed its height in place.
   *
   * Expanding a hunk inserts rows into markup already on screen, so nothing the
   * viewer rendered changed and its recorded height is now short by however
   * many rows arrived.
   */
  remeasure: (index: number) => void
  collapseAll: (collapsed: boolean) => void
  scrollToFile: (index: number) => void
  /** The files, in diff order. */
  files: () => readonly DiffFileEntry[]
  destroy: () => void
}

export function createDiffViewer(options: DiffViewerOptions): DiffViewer {
  const { scroller, content, renderFile, releaseFile, onVisibleChange } = options

  const entries: DiffFileEntry[] = []
  const geometry: ViewportFile[] = []
  const hosts = new Map<number, HTMLElement>()
  const pool: HTMLElement[] = []

  let layout = options.layout ?? 'unified'
  const overscan = options.overscan ?? DEFAULT_OVERSCAN
  let frame: number | null = null
  let anchor: ScrollAnchor | null = null
  let destroyed = false
  // The last position we wrote ourselves, so the scroll event it causes is not
  // read back as the reader having scrolled. A value rather than a flag,
  // because a write that lands on the position the scroller is already at
  // fires no event at all, and a flag left standing would then swallow the
  // reader's next real scroll and the list would stick.
  let writtenScrollTop: number | null = null

  // The list is positioned rather than flowed, so a file mounting or being
  // released cannot move the ones around it.
  content.style.position = 'relative'

  function schedule(): void {
    if (destroyed || frame != null)
      return

    frame = requestAnimationFrame(() => {
      frame = null
      apply()
    })
  }

  /**
   * One frame: decide, then measure, then write.
   *
   * The three phases are kept apart on purpose. Interleaving a measurement with
   * a mutation forces the browser to lay out again before it can answer, and a
   * list doing that once per mounted file spends the frame in layout.
   */
  function apply(): void {
    if (destroyed)
      return

    const result = planFrame(
      geometry,
      new Set(hosts.keys()),
      { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
      {
        layout,
        overscan,
        anchor,
        devicePixelRatio: window.devicePixelRatio,
      },
    )

    anchor = null

    for (const index of result.plan.unmount)
      release(index)

    for (const index of result.plan.mount)
      mount(index)

    content.style.height = `${result.layout.total}px`

    for (const [index, host] of hosts)
      host.style.transform = `translateY(${result.layout.offsets[index]!}px)`

    if (result.scrollTop != null) {
      writtenScrollTop = result.scrollTop
      scroller.scrollTop = result.scrollTop
    }

    // Measured after mounting, in one pass, so the reads do not interleave with
    // the writes above. A height that differs from the estimate takes effect on
    // the next frame, anchored, so nothing the reader is looking at moves.
    let remeasured = false
    for (const [index, host] of hosts) {
      const measured = host.offsetHeight
      if (measured > 0 && geometry[index]!.measured !== measured) {
        geometry[index]!.measured = measured
        remeasured = true
      }
    }

    if (remeasured) {
      anchor = captureAnchor(result.layout, scroller.scrollTop)
      schedule()
    }

    const mountedIndexes = [...hosts.keys()]
    if (onVisibleChange && mountedIndexes.length > 0) {
      onVisibleChange(
        Math.min(...mountedIndexes),
        Math.max(...mountedIndexes) + 1,
      )
    }
  }

  function mount(index: number): void {
    const entry = entries[index]
    if (!entry)
      return

    const host = pool.pop() ?? createHost()
    host.dataset.fileIndex = String(index)
    host.dataset.path = entry.path

    renderFile(entry, host)

    hosts.set(index, host)
    content.appendChild(host)
  }

  function release(index: number): void {
    const host = hosts.get(index)
    if (!host)
      return

    const entry = entries[index]
    if (entry && releaseFile)
      releaseFile(entry, host)

    hosts.delete(index)
    host.remove()

    // Recycled rather than discarded. Creating and destroying a host per file
    // is what turns a long scroll into a sawtooth of allocation and collection.
    if (pool.length < POOL_LIMIT)
      pool.push(host)
  }

  function createHost(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'diff-file-host'
    host.style.position = 'absolute'
    host.style.top = '0'
    host.style.left = '0'
    host.style.width = '100%'
    // One file's layout cannot invalidate another's, which is what keeps a
    // relayout proportional to the screen rather than to the diff.
    host.style.contain = 'layout paint style'

    return host
  }

  function onScroll(): void {
    if (writtenScrollTop != null && scroller.scrollTop === writtenScrollTop) {
      writtenScrollTop = null
      return
    }

    writtenScrollTop = null
    schedule()
  }

  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
        // The viewport changed shape, so every measured height is suspect: a
        // line that wrapped at one width may not at another.
        anchor = captureAnchor(
          planFrame(geometry, new Set(hosts.keys()), { scrollTop: scroller.scrollTop, height: scroller.clientHeight }, { layout, overscan }).layout,
          scroller.scrollTop,
        )
        for (const file of geometry)
          file.measured = undefined
        schedule()
      })

  scroller.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver?.observe(scroller)

  /** Take an anchor now, so a change that moves things can put the reader back. */
  function anchorNow(): void {
    const { layout: current } = planFrame(
      geometry,
      new Set(hosts.keys()),
      { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
      { layout, overscan },
    )
    anchor = captureAnchor(current, scroller.scrollTop)
  }

  return {
    addFiles(files) {
      if (files.length === 0)
        return

      for (const file of files) {
        entries.push(file)
        geometry.push({ rows: file.rows, collapsed: file.collapsed })
      }

      schedule()
    },

    setLayout(next) {
      if (next === layout)
        return

      // Split and unified are different heights for the same file, so this
      // moves everything below the reader. Anchored, so it does not move them.
      anchorNow()
      layout = next

      // Every measurement was taken in the other layout.
      for (const file of geometry)
        file.measured = undefined

      // Mounted files have to be re-rendered in the new layout.
      for (const index of [...hosts.keys()])
        release(index)

      schedule()
    },

    remeasure(index) {
      const file = geometry[index]
      if (!file)
        return

      // Cleared rather than measured here: the next frame measures every
      // mounted file in one pass, and anchors the correction so nothing the
      // reader is looking at moves.
      file.measured = undefined
      anchor = captureAnchor(measuredLayout(geometry, { layout }), scroller.scrollTop)
      schedule()
    },

    refresh(index) {
      const host = hosts.get(index)
      const entry = entries[index]
      if (!host || !entry)
        return

      renderFile(entry, host)
      // Its height almost certainly changed, so the next frame measures it and
      // anchors the correction.
      schedule()
    },

    setCollapsed(index, collapsed) {
      const entry = entries[index]
      if (!entry || entry.collapsed === collapsed)
        return

      anchorNow()
      entry.collapsed = collapsed
      geometry[index]!.collapsed = collapsed

      // Re-rendered rather than hidden with CSS, so a collapsed file is not
      // holding the markup of the eight thousand lines it is not showing.
      if (hosts.has(index))
        release(index)

      schedule()
    },

    collapseAll(collapsed) {
      anchorNow()

      for (let index = 0; index < entries.length; index++) {
        entries[index]!.collapsed = collapsed
        geometry[index]!.collapsed = collapsed
      }

      for (const index of [...hosts.keys()])
        release(index)

      schedule()
    },

    scrollToFile(index) {
      const { layout: current } = planFrame(
        geometry,
        new Set(hosts.keys()),
        { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
        { layout, overscan },
      )

      const top = current.offsets[index]
      if (top == null)
        return

      writtenScrollTop = top
      scroller.scrollTop = top
      schedule()
    },

    files() {
      return entries
    },

    destroy() {
      destroyed = true

      if (frame != null)
        cancelAnimationFrame(frame)

      scroller.removeEventListener('scroll', onScroll)
      resizeObserver?.disconnect()

      for (const index of [...hosts.keys()])
        release(index)

      pool.length = 0
    },
  }
}

/**
 * Read a newline-delimited JSON stream, yielding records as they land.
 *
 * The point is the same as everywhere else in this pipeline: the first record
 * is usable before the last one has been written. A response parsed as one JSON
 * document would have to be complete first, which on a large compare is the
 * difference between a page that fills in and a page that waits.
 */
export async function* readNdjson<T>(response: Response, signal?: AbortSignal): AsyncGenerator<T> {
  const body = response.body
  if (!body)
    return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      if (signal?.aborted)
        return

      const { done, value } = await reader.read()
      if (done)
        break

      buffer += decoder.decode(value, { stream: true })

      // A record is only complete once its newline has arrived, so the last
      // partial line stays in the buffer for the next read.
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        if (line.trim().length > 0)
          yield JSON.parse(line) as T

        newline = buffer.indexOf('\n')
      }
    }

    const rest = buffer.trim()
    if (rest.length > 0)
      yield JSON.parse(rest) as T
  }
  finally {
    reader.releaseLock()
  }
}

export interface ManifestStreamHandlers {
  onFiles: (files: DiffFileEntry[]) => void
  /** Markup for one file, ready to mount. */
  onRows?: (index: number, html: string) => void
  /**
   * Rows stopped here.
   *
   * Everything from this index onwards has to be fetched as the reader reaches
   * it. Announced rather than inferred, because a file that simply has no rows
   * yet is indistinguishable from one that never will.
   */
  onRowsTruncated?: (from: number) => void
  /**
   * git succeeded but said something that changes what the reader is seeing.
   *
   * Worth showing. The case it exists for is git giving up on rename detection
   * on a large diff, where a moved file arrives as a deletion and an addition
   * and a reviewer reads it as new code.
   */
  onNotice?: (message: string) => void
  onEnd?: (summary: { files: number, additions: number, deletions: number }) => void
  onError?: (message: string) => void
}

/**
 * Pull a diff manifest and hand it over in batches.
 *
 * Batched rather than one at a time, and against a clock as well as a count: a
 * diff of forty thousand files would otherwise schedule forty thousand frames,
 * and one of twelve would wait for a batch that never fills. Whichever comes
 * first wins, so both shapes stay responsive.
 */
export async function streamDiffManifest(
  url: string,
  handlers: ManifestStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/x-ndjson' } })

  if (!response.ok) {
    handlers.onError?.(await response.text())
    return
  }

  let batch: DiffFileEntry[] = []
  let lastFlush = performance.now()

  const flush = () => {
    if (batch.length === 0)
      return

    handlers.onFiles(batch)
    batch = []
    lastFlush = performance.now()
  }

  for await (const record of readNdjson<Record<string, unknown>>(response, signal)) {
    if (record.t === 'file') {
      batch.push(toFileEntry(record))

      if (batch.length >= MANIFEST_BATCH_SIZE || performance.now() - lastFlush >= MANIFEST_BATCH_MS)
        flush()
    }
    else if (record.t === 'rows') {
      // Flushed first, so the viewer has the file before it is handed markup
      // for it. Out of order, the rows would arrive for a file the list has
      // never heard of.
      flush()
      handlers.onRows?.(Number(record.i), String(record.html))
    }
    else if (record.t === 'rows-truncated') {
      flush()
      handlers.onRowsTruncated?.(Number(record.from))
    }
    else if (record.t === 'notice') {
      handlers.onNotice?.(String(record.message))
    }
    else if (record.t === 'end') {
      flush()
      handlers.onEnd?.(record as unknown as { files: number, additions: number, deletions: number })
    }
    else if (record.t === 'error') {
      flush()
      handlers.onError?.(String(record.message ?? 'The diff could not be loaded.'))
    }
  }

  flush()
}

export { DEFAULT_HEIGHT_METRICS }

/**
 * Start a viewer against the element the page rendered for it.
 *
 * The one call a page makes. Everything it needs is read from data attributes
 * on that element rather than passed in, because an stx client script is not
 * the place for DOM code and the template should not be reaching for elements
 * either. The template renders a host and says what to load; this finds it.
 *
 * Returns null when the page has no host, so a shared client script can run on
 * pages that do not show a diff without a guard at every call site.
 */
export function mountDiffFiles(): DiffViewer | null {
  const root = document.querySelector<HTMLElement>('[data-diff-stream]')
  const manifestUrl = root?.dataset.manifestUrl
  if (!root || !manifestUrl)
    return null

  // Searched for in the document rather than inside the host: the status line
  // belongs in the page header beside the branch names, which is outside the
  // scroll region the viewer owns.
  const status = document.querySelector<HTMLElement>('[data-diff-status]')
  const scroller = root.querySelector<HTMLElement>('[data-diff-scroller]')
  const content = root.querySelector<HTMLElement>('[data-diff-content]')
  if (!scroller || !content)
    return null

  const rowsUrl = root.dataset.rowsUrl
  const contextUrl = root.dataset.contextUrl

  // The reader's own choice wins over the page's default, which is what the
  // server rendered the first batch of rows in.
  const stored = readStoredLayout()
  const initialLayout = stored ?? (root.dataset.layout === 'split' ? 'split' : 'unified')
  let layout: 'unified' | 'split' = initialLayout
  // The layout the page rendered its inline rows in, which is what those arrive
  // already shaped as.
  const servedLayout: 'unified' | 'split' = root.dataset.layout === 'split' ? 'split' : 'unified'
  // Markup for files whose rows have arrived, by index. A file the reader has
  // not reached yet costs one string; a file they scrolled past costs the same
  // string and no elements.
  // Tagged with the layout each was rendered in. Rows arrive as markup, not as
  // data, so a file cached in one layout is of no use in the other and has to
  // be asked for again - per file, because the reader may switch back before
  // the whole list has been refetched.
  const markup = new Map<number, { html: string, layout: 'unified' | 'split' }>()
  let truncatedFrom: number | null = null

  // Files mounted without markup, waiting to be asked for, and the ones already
  // asked for. Two sets rather than one, so a slow response does not make the
  // viewer ask again on every frame the file stays on screen.
  const wanted = new Set<number>()
  const asked = new Set<number>()
  let fetchTimer: number | null = null

  const say = (message: string, tone: 'working' | 'done' | 'warn' | 'error' = 'working') => {
    if (!status)
      return
    status.textContent = message
    status.dataset.tone = tone
  }

  const viewer = createDiffViewer({
    scroller,
    content,
    layout: initialLayout,
    renderFile(file, host) {
      const cached = markup.get(file.index)
      if (cached != null && cached.layout === layout) {
        host.innerHTML = cached.html
        return
      }

      // Either past the point where inline rows stopped, or rendered in a
      // layout the reader has since switched away from. Queued rather than
      // fetched here: mounting happens inside a render pass, and a screenful of
      // files should be one request rather than twenty.
      if (rowsUrl != null && !asked.has(file.index)) {
        wanted.add(file.index)
        scheduleRowFetch()
      }

      // Rows for this file have not arrived. A placeholder the right height
      // rather than an empty box, so the scrollbar does not lurch when they do.
      host.innerHTML = `<section class="diff-file is-pending panel">`
        + `<header class="diff-head"><span class="diff-path mono">${escapeText(file.path)}</span>`
        + `<span class="diff-counts mono"><span class="count-add">+${file.additions}</span>`
        + `<span class="count-del">-${file.deletions}</span></span></header></section>`
    },
  })

  /**
   * Ask for the rows of files that are on screen without any.
   *
   * Batched behind a frame, so a scroll that mounts twenty files makes one
   * request. Asked for by path, which is what lets the server hand `git diff` a
   * pathspec instead of walking to an offset.
   */
  function scheduleRowFetch(): void {
    if (fetchTimer != null || wanted.size === 0)
      return

    fetchTimer = window.setTimeout(() => {
      fetchTimer = null
      void fetchWantedRows()
    }, ROW_FETCH_DELAY_MS)
  }

  async function fetchWantedRows(): Promise<void> {
    if (rowsUrl == null || wanted.size === 0)
      return

    const files = viewer.files()
    const batch = [...wanted].slice(0, ROW_FETCH_BATCH)
    const query = new URLSearchParams()

    for (const index of batch) {
      wanted.delete(index)
      const file = files[index]
      if (!file)
        continue
      asked.add(index)
      query.append('path', file.path)
    }

    if ([...query].length === 0)
      return

    // Indexed by path on the way back, because the rows response numbers files
    // from zero within its own small diff and those are not the positions the
    // list uses.
    const indexByPath = new Map<string, number>()
    for (const index of batch) {
      const file = files[index]
      if (file)
        indexByPath.set(file.path, index)
    }

    try {
      const requested = layout
      const response = await fetch(`${rowsUrl}&layout=${requested}&${query}`, {
        headers: { Accept: 'application/x-ndjson' },
      })
      if (!response.ok)
        throw new Error(await response.text())

      let pathOfCurrent: string | null = null
      for await (const record of readNdjson<Record<string, unknown>>(response)) {
        if (record.t === 'file') {
          pathOfCurrent = String(record.path)
        }
        else if (record.t === 'rows' && pathOfCurrent != null) {
          const index = indexByPath.get(pathOfCurrent)
          // Dropped when the reader switched layout while this was in flight:
          // the markup is real, and it is the wrong shape.
          if (index != null && requested === layout) {
            markup.set(index, { html: String(record.html), layout: requested })
            viewer.refresh(index)
          }
        }
      }
    }
    catch {
      // Let them be asked for again: a failed batch that stayed in `asked`
      // would leave those files showing a placeholder for the rest of the visit
      // with no way to recover but a reload.
      for (const index of batch)
        asked.delete(index)
    }

    if (wanted.size > 0)
      scheduleRowFetch()
  }

  // Both delegated rather than bound per file: headers and hunk rows come and
  // go as the reader scrolls, and a listener per mounted file would have to be
  // added and removed with them.
  content.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    const host = target?.closest<HTMLElement>('.diff-file-host')
    const index = host?.dataset.fileIndex
    if (index == null)
      return

    const toggle = target?.closest<HTMLElement>('.diff-toggle')
    if (toggle) {
      event.preventDefault()
      const file = viewer.files()[Number(index)]
      if (file)
        viewer.setCollapsed(Number(index), !file.collapsed)
      return
    }

    const expand = target?.closest<HTMLElement>('.hunk-expand')
    if (expand) {
      event.preventDefault()
      void expandGap(Number(index), expand)
    }
  })

  /**
   * Fill in the lines a hunk left out.
   *
   * The rows are inserted before the hunk header that offered them, which is
   * where the gap is. The control is replaced rather than left in place when
   * the whole gap has been shown, so it does not sit there offering nothing.
   */
  async function expandGap(index: number, control: HTMLElement): Promise<void> {
    if (contextUrl == null || control.dataset.busy === 'true')
      return

    const file = viewer.files()[index]
    const from = Number(control.dataset.expandFrom)
    const to = Number(control.dataset.expandTo)
    const offset = Number(control.dataset.expandOffset ?? 0)
    if (!file || !Number.isFinite(from) || !Number.isFinite(to))
      return

    control.dataset.busy = 'true'

    try {
      const query = new URLSearchParams({
        path: file.path,
        from: String(from),
        to: String(to),
        offset: String(offset),
        layout,
      })
      const response = await fetch(`${contextUrl}&${query}`, { headers: { Accept: 'application/json' } })
      if (!response.ok)
        throw new Error(await response.text())

      const expanded = await response.json() as { html: string, count: number, more: boolean }
      const row = control.closest('tr')
      if (!row || expanded.count === 0)
        return

      row.insertAdjacentHTML('beforebegin', expanded.html)

      if (expanded.more) {
        // More to come, so the control stays and asks for what is left: the
        // same end, starting after what just arrived.
        control.dataset.expandFrom = String(from + expanded.count)
        control.dataset.expandTo = String(to)
      }
      else {
        control.remove()
      }

      // The file just got taller by however many rows arrived.
      viewer.remeasure(index)
    }
    catch {
      // Left in place to be tried again. A control that vanished on a failed
      // request would take the only way back with it.
    }
    finally {
      delete control.dataset.busy
    }
  }

  // The layout toggle, if the page rendered one. Wired here rather than in the
  // template so the template holds no DOM code.
  const toggle = document.querySelector<HTMLElement>('[data-diff-layout-toggle]')
  const showLayout = () => {
    if (toggle) {
      toggle.dataset.layout = layout
      toggle.setAttribute('aria-pressed', layout === 'split' ? 'true' : 'false')
      toggle.textContent = layout === 'split' ? 'Split' : 'Unified'
    }
  }

  toggle?.addEventListener('click', () => {
    layout = layout === 'split' ? 'unified' : 'split'
    writeStoredLayout(layout)
    showLayout()

    // The geometry switches immediately: the manifest carried the row counts
    // for both layouts, so the list knows every file's new height without
    // asking. Only the markup has to be fetched again.
    asked.clear()
    wanted.clear()
    viewer.setLayout(layout)
  })

  showLayout()
  say('Loading the diff…')

  void streamDiffManifest(manifestUrl, {
    onFiles(files) {
      viewer.addFiles(files)
      say(`${viewer.files().length} files…`)
    },
    onRows(index, html) {
      markup.set(index, { html, layout: servedLayout })
      // The file was laid out the moment its record arrived, so by now it may
      // already be on screen showing a placeholder.
      viewer.refresh(index)
    },
    onRowsTruncated(from) {
      truncatedFrom = from
      // Files already mounted past this point are showing placeholders and have
      // nothing coming, so they have to be asked for now.
      for (const file of viewer.files()) {
        if (file.index >= from && !markup.has(file.index))
          wanted.add(file.index)
      }

      scheduleRowFetch()
    },
    onNotice(message) {
      say(message, 'warn')
    },
    onEnd(summary) {
      const counts = `${summary.files} files, +${summary.additions} -${summary.deletions}`
      say(truncatedFrom == null ? counts : `${counts} (rendered to file ${truncatedFrom})`, 'done')
    },
    onError(message) {
      say(message, 'error')
    },
  }).catch((error: unknown) => {
    say(error instanceof Error ? error.message : 'The diff could not be loaded.', 'error')
  })

  return viewer
}

/** Escape text for the placeholder, which is the only markup built here. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
