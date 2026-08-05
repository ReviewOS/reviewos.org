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
import {
  captureAnchor,
  DEFAULT_OVERSCAN,
  measuredLayout,
  planFrame,
  type ScrollAlignment,
  scrollBehaviourFor,
  scrollTargetFor,
  snapToDevicePixel,
} from '../../app/Actions/Pull/viewport'
import {
  anchorBetween,
  anchorCovers,
  formatLineAnchor,
  type LineAnchor,
  parseLineAnchor,
} from '../../app/Actions/Pull/lineLink'
import { applyPreferences, type DiffPreferences, readPreferences, wirePreferenceControls, writePreferences } from './diffprefs'
// From `shell.ts` rather than from `rows.ts`, and that is the whole reason
// `shell.ts` exists: `rows.ts` reaches the highlighter, and the browser must
// never download forty eight grammars to draw a file header.
import { renderDiffShell } from '../../app/Actions/Pull/shell'

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

/** One row. Fixed, which is what makes the window a division rather than a layout. */
const FILE_ROW_HEIGHT = 26

/** Rows rendered beyond the viewport, so a scroll does not outrun the paint. */
const FILE_LIST_OVERSCAN = 200

/**
 * The list of files beside the diff.
 *
 * Windowed like the diff itself, and for the same reason: a forty thousand file
 * compare is forty thousand rows, and a sidebar that renders all of them costs
 * more than the diff it is helping somebody navigate. Rows here are a fixed
 * height, so the arithmetic is a division rather than a layout.
 *
 * A flat list rather than a folded tree. The directory is shown dimmed beside
 * the filename, which is what a reviewer reads to tell two `index.ts` apart;
 * folding is a state machine that earns its keep on a repository browser and
 * not on a diff, where every file listed is one somebody changed.
 */
export function createFileList(options: {
  host: HTMLElement
  onSelect: (index: number) => void
}): {
  setFiles: (files: readonly DiffFileEntry[]) => void
  setCurrent: (index: number) => void
  destroy: () => void
} {
  const { host, onSelect } = options
  const viewport = document.createElement('div')
  const sizer = document.createElement('div')
  const rows = document.createElement('div')

  viewport.className = 'file-list-viewport'
  sizer.className = 'file-list-sizer'
  rows.className = 'file-list-rows'
  sizer.appendChild(rows)
  viewport.appendChild(sizer)
  host.appendChild(viewport)

  let files: readonly DiffFileEntry[] = []
  let current = -1
  let frame: number | null = null

  const schedule = () => {
    if (frame == null)
      frame = requestAnimationFrame(() => { frame = null; paint() })
  }

  function paint(): void {
    const height = viewport.clientHeight || 1
    const total = files.length * FILE_ROW_HEIGHT
    sizer.style.height = `${total}px`

    const first = Math.max(0, Math.floor((viewport.scrollTop - FILE_LIST_OVERSCAN) / FILE_ROW_HEIGHT))
    const last = Math.min(
      files.length,
      Math.ceil((viewport.scrollTop + height + FILE_LIST_OVERSCAN) / FILE_ROW_HEIGHT),
    )

    rows.style.transform = `translateY(${first * FILE_ROW_HEIGHT}px)`
    rows.innerHTML = files.slice(first, last).map((file, offset) => {
      const index = first + offset
      const cut = file.path.lastIndexOf('/')
      const directory = cut < 0 ? '' : file.path.slice(0, cut + 1)
      const name = cut < 0 ? file.path : file.path.slice(cut + 1)

      return `<button type="button" class="file-row${index === current ? ' is-current' : ''}"`
        + ` data-file-index="${index}" title="${escapeAttribute(file.path)}">`
        + `<span class="file-status file-status-${escapeAttribute(file.status)}" aria-hidden="true"></span>`
        + `<span class="file-name">`
        + (directory ? `<span class="file-dir">${escapeText(directory)}</span>` : '')
        + `${escapeText(name)}</span>`
        + `<span class="file-counts mono"><span class="count-add">+${file.additions}</span>`
        + `<span class="count-del">-${file.deletions}</span></span></button>`
    }).join('')
  }

  const onScroll = () => schedule()
  viewport.addEventListener('scroll', onScroll, { passive: true })

  const onClick = (event: Event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.file-row')
    if (row?.dataset.fileIndex != null)
      onSelect(Number(row.dataset.fileIndex))
  }
  viewport.addEventListener('click', onClick)

  return {
    setFiles(next) {
      files = next
      schedule()
    },
    setCurrent(index) {
      if (index === current)
        return

      current = index
      schedule()

      // Follow the reader down the diff, but only when the row would otherwise
      // be off screen: scrolling a sidebar somebody is reading is worse than
      // letting them lose their place in it.
      const top = index * FILE_ROW_HEIGHT
      const bottom = top + FILE_ROW_HEIGHT
      if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight)
        viewport.scrollTop = top - viewport.clientHeight / 3
    },
    destroy() {
      if (frame != null)
        cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('click', onClick)
      viewport.remove()
    },
  }
}

/** Escape for a double-quoted attribute value. */
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/**
 * Whether a key press belongs to a field rather than to the page.
 *
 * A reply box is a text field, and `j` in one means the letter j.
 */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string')
    return false

  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable
}

/** How long a row request waits to collect more files before it goes. */
const ROW_FETCH_DELAY_MS = 32

/** Files per row request. Matches the server's own cap on how many it will take. */
const ROW_FETCH_BATCH = 40

/** Files per batch handed to the viewer, after the first one. */
const MANIFEST_BATCH_SIZE = 25

/** And the longest a batch waits to be handed over, however few are in it. */
const MANIFEST_BATCH_MS = 100

/**
 * The first batch waits longer.
 *
 * Everything after it is appended below the fold, where a hundred milliseconds
 * of latency is invisible. The first one *is* the page, and half a second buys
 * a screen that is full rather than a screen that fills in while the reader
 * watches. Past that it is a spinner with extra steps, so it is a ceiling and
 * not a delay: whichever of the two conditions comes first still wins.
 */
const FIRST_BATCH_MS = 500

/** Bounds on the first batch, whatever the viewport works out to. */
const FIRST_BATCH_MIN = 25
const FIRST_BATCH_MAX = 96

/**
 * How long parsing may hold the main thread before yielding.
 *
 * Eight milliseconds is half a frame at sixty. The work is not interruptible
 * once started - a record is parsed or it is not - so the budget is checked
 * between records, and a single pathological record can still overrun it.
 */
const WORK_BUDGET_MS = 8

/**
 * How big the first batch should be, from the size of the viewport.
 *
 * Rows that would fit, not files: a file is a header plus its rows, so this
 * over-counts, and deliberately. Under-filling the first screen is the failure
 * that shows - the reader watches the page assemble itself - and over-filling
 * it costs a few file records the browser was going to receive anyway. The
 * ceiling is what stops that argument running away.
 */
export function firstBatchSize(viewportHeight: number, rowHeight: number): number {
  if (!(viewportHeight > 0) || !(rowHeight > 0))
    return FIRST_BATCH_MIN

  return Math.max(FIRST_BATCH_MIN, Math.min(FIRST_BATCH_MAX, Math.ceil(viewportHeight / rowHeight)))
}

/** One frame, so a mount or a measurement has happened before reading it back. */
function nextFrame(): Promise<void> {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

/**
 * Hand the thread back to the browser.
 *
 * A frame if there is going to be one, and a timeout if there is not. A
 * backgrounded tab gets no animation frames at all, so a stream that yielded
 * only on `requestAnimationFrame` would stop dead when somebody opened a diff
 * in a background tab and went to read something else - which is exactly how
 * people open several pull requests.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done)
        return
      done = true
      resolve()
    }

    requestAnimationFrame(finish)
    setTimeout(finish, 0)
  })
}

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
  /**
   * Called at the end of every applied frame.
   *
   * For state the caller paints onto rows rather than into them: a row that
   * scrolled away and came back is a new element carrying none of it.
   */
  afterRender?: () => void
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
  /**
   * Measure every file again, because something changed all of them.
   *
   * Turning word wrap on is the case: nothing the viewer rendered changed, and
   * every measured height is now wrong by however many lines wrapped. Cheaper
   * than it sounds - only mounted files are measured, and the rest go back to
   * their estimates, which is what they would have had anyway.
   */
  remeasureAll: () => void
  collapseAll: (collapsed: boolean) => void
  scrollToFile: (index: number, target?: ScrollToOptions) => void
  /** The files, in diff order. */
  files: () => readonly DiffFileEntry[]
  /**
   * What the viewer has been doing.
   *
   * For the benchmark harness, which cannot see any of this from outside: a
   * mount count that climbs with the scroll distance means rows are being
   * recycled, and one that climbs with the *file* count means they are not.
   */
  stats: () => ViewerStats
  destroy: () => void
}

export interface ScrollToOptions {
  alignment?: ScrollAlignment
  /** Pixels into the file, for scrolling to a line rather than to a file. */
  offset?: number
  /** Room to leave above, for a sticky header sitting over the target. */
  headerOffset?: number
  /** Animated, unless the reader has asked for less motion. */
  smooth?: boolean
}

/**
 * Safari, and only Safari.
 *
 * Chrome's user agent string also contains `Safari`, which is why this looks
 * for Chrome and Chromium and excludes them rather than looking for Safari.
 * User agent sniffing is the wrong tool for almost everything and is the right
 * one here: the guard below is for a specific rendering bug in one engine, it
 * costs two synchronous layouts, and there is nothing to feature-detect.
 */
function isWebKit(): boolean {
  const agent = navigator.userAgent
  return /\bSafari\b/.test(agent) && !/Chrom(e|ium)|Android/.test(agent)
}

/**
 * The width the scrollbar takes out of a scrolling pane.
 *
 * Measured once, with a probe carrying the real class, so custom scrollbar CSS
 * is reflected rather than assumed away. Zero on a machine with overlay
 * scrollbars, which is most Macs, and fifteen or so on Windows - and that
 * difference is exactly why the split columns have to be told rather than left
 * to work it out: one side scrolls and the other does not, and they end up
 * disagreeing about their width by the width of a scrollbar.
 */
export function measureScrollbarGutter(): number {
  const probe = document.createElement('div')
  probe.className = 'diff-body'
  probe.style.cssText = 'position:absolute;top:-9999px;width:200px;height:100px;overflow:scroll;visibility:hidden'

  const filler = document.createElement('div')
  filler.style.cssText = 'width:400px;height:400px'
  probe.appendChild(filler)

  document.body.appendChild(probe)
  const gutter = probe.offsetWidth - probe.clientWidth
  probe.remove()

  return gutter
}

/**
 * Whether the reader has asked for less motion.
 *
 * Asked at the moment of scrolling rather than captured once: it can change
 * while the page is open, and a viewer that cached it at startup would go on
 * animating for the rest of the visit.
 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface ViewerStats {
  /** Files mounted since the viewer was created. */
  mounts: number
  /** Files released. The difference between the two is what is on screen. */
  releases: number
  /** Hosts taken from the pool rather than created, which is the point of it. */
  recycled: number
  /** Frames the viewer actually applied, as opposed to frames the browser drew. */
  frames: number
  /** Hosts held for reuse. */
  pooled: number
  /** Files known, whether or not any of them have been rendered. */
  files: number
}

export function createDiffViewer(options: DiffViewerOptions): DiffViewer {
  const { scroller, content, renderFile, releaseFile, onVisibleChange, afterRender } = options

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
  const counters = { mounts: 0, releases: 0, recycled: 0, frames: 0 }
  // Asked once. The engine does not change while the page is open, and the
  // answer gates two synchronous layouts per frame.
  const webkit = isWebKit()

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

    counters.frames++

    // Safari clamps an ancestor scroller to zero when the subtree of a
    // `container-type` element is rewritten in bulk, which is every frame that
    // mounts a file. See https://bugs.webkit.org/show_bug.cgi?id=308027. Pinning
    // a minimum height across the rewrite keeps the scroller's range alive
    // while the DOM is in flux. Two synchronous layouts, so it is Safari only.
    const pinned = webkit ? content.offsetHeight : 0
    if (pinned > 0)
      content.style.minHeight = `${pinned}px`

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

    if (pinned > 0) {
      // Read once while still pinned, so the layout the browser settles on is
      // the one with the new content in it, then release. Unpinning without
      // the read is the same as never pinning.
      void content.offsetHeight
      content.style.minHeight = ''
    }

    afterRender?.()

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

    const pooled = pool.pop()
    if (pooled)
      counters.recycled++

    const host = pooled ?? createHost()
    counters.mounts++
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

    counters.releases++
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
    //
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

    remeasureAll() {
      // The anchor is taken against the layout as it stands, before the
      // measurements are dropped, so the correction that follows can put the
      // reader back on the line they were reading.
      anchorNow()

      for (const file of geometry)
        file.measured = undefined

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
      // What it measured was the other state, and measurements now win over
      // estimates whether a file is folded or not.
      geometry[index]!.measured = undefined

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
        geometry[index]!.measured = undefined
      }

      for (const index of [...hosts.keys()])
        release(index)

      schedule()
    },

    scrollToFile(index, target = {}) {
      const { layout: current } = planFrame(
        geometry,
        new Set(hosts.keys()),
        { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
        { layout, overscan },
      )

      const top = scrollTargetFor(current, scroller.clientHeight, { ...target, index })
      if (top == null)
        return

      const position = snapToDevicePixel(top, window.devicePixelRatio)
      const behavior = scrollBehaviourFor(target.smooth === true, prefersReducedMotion())

      if (behavior === 'smooth') {
        // Not recorded as ours: a smooth scroll fires scroll events all the
        // way there, and swallowing only the final one would leave the list
        // ignoring every frame of the animation.
        scroller.scrollTo({ top: position, behavior })
      }
      else {
        writtenScrollTop = position
        scroller.scrollTop = position
      }

      schedule()
    },

    files() {
      return entries
    },

    stats() {
      return { ...counters, pooled: pool.length, files: entries.length }
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

export interface ManifestStreamOptions {
  /**
   * Files in the first batch, which should be a screenful.
   *
   * See `firstBatchSize`. Passed in rather than measured here, because this
   * function does not own a viewport and should not go looking for one.
   */
  firstBatchSize?: number
}

/**
 * Pull a diff manifest and hand it over in batches.
 *
 * Three things decide when a batch goes out, and all three are needed:
 *
 * - a **count**, so a forty thousand file compare does not schedule forty
 *   thousand frames
 * - a **clock**, so a twelve file pull request does not wait for a batch that
 *   will never fill
 * - a **work budget**, so a run of very large files cannot hold the main
 *   thread between the other two. Parsing every record as fast as they arrive
 *   and publishing on a timer still leaves the thread pinned, which is the
 *   failure this one exists for: the page is not repainting, so nothing the
 *   reader does gets a response, and the batching looks like it is working.
 */
export async function streamDiffManifest(
  url: string,
  handlers: ManifestStreamHandlers,
  signal?: AbortSignal,
  options: ManifestStreamOptions = {},
): Promise<void> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/x-ndjson' } })

  if (!response.ok) {
    handlers.onError?.(await response.text())
    return
  }

  const firstSize = options.firstBatchSize ?? FIRST_BATCH_MIN
  let batch: DiffFileEntry[] = []
  let published = 0
  let lastFlush = performance.now()
  let sinceYield = performance.now()

  const flush = () => {
    if (batch.length === 0)
      return

    handlers.onFiles(batch)
    published++
    batch = []
    lastFlush = performance.now()
  }

  /** The batch this one is: the first is bigger and waits longer. */
  const limits = () => published === 0
    ? { size: firstSize, ms: FIRST_BATCH_MS }
    : { size: MANIFEST_BATCH_SIZE, ms: MANIFEST_BATCH_MS }

  for await (const record of readNdjson<Record<string, unknown>>(response, signal)) {
    // Checked before the record is handled rather than after, so the yield
    // happens between two records and never in the middle of one.
    if (performance.now() - sinceYield >= WORK_BUDGET_MS) {
      await yieldToBrowser()
      sinceYield = performance.now()
    }

    if (record.t === 'file') {
      batch.push(toFileEntry(record))

      const { size, ms } = limits()
      if (batch.length >= size || performance.now() - lastFlush >= ms)
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

  // Captured after the guard. The narrowing does not reach the closures below,
  // and asserting it at every use site reads as though these might be null when
  // they cannot be.
  const region: HTMLElement = content
  const view: HTMLElement = scroller

  const rowsUrl = root.dataset.rowsUrl
  const contextUrl = root.dataset.contextUrl

  // The reader's own choices win over the page's defaults, which is what the
  // server rendered the first batch of rows in. Applied to the root before
  // anything mounts, so the first file to appear is already shaped the way the
  // reader asked rather than being restyled a frame later.
  const settingsPanel = document.querySelector<HTMLElement>('[data-diff-settings]')
  const preferences: DiffPreferences = settingsPanel
    ? wirePreferenceControls({
        root,
        panel: settingsPanel,
        onChange: (next, changed) => {
          // Everything but wrapping is a repaint of markup that is already
          // there. Wrapping changes how tall every line is, so what the viewer
          // measured is now wrong for every mounted file.
          if (changed === 'wrap')
            viewer.remeasureAll()
        },
      })
    : readPreferences()

  if (!settingsPanel)
    applyPreferences(root, preferences)

  const initialLayout = preferences.layout
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
  /**
   * The lines the reader has selected, which is also what the URL says.
   *
   * Read from the fragment on load, so a link somebody was sent selects what
   * they were sent rather than merely scrolling near it.
   */
  let selection: LineAnchor | null = parseLineAnchor(window.location.hash)

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
    afterRender: () => paintSelection(),
    // The sidebar follows the diff rather than the other way round, so the row
    // highlighted is the file the reader is actually looking at.
    onVisibleChange: start => fileList?.setCurrent(start),
    renderFile(file, host) {
      // Folded up: the header and nothing else. No rows are asked for, because
      // the reader has not asked to see any, and a diff where every collapsed
      // lock file quietly fetches itself is a diff that collapses nothing.
      if (file.collapsed) {
        host.innerHTML = renderDiffShell(file, { collapsed: true })
        return
      }

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

      // Rows for this file have not arrived. The same header it will have when
      // they do, so opening a diff does not look like a list of grey boxes
      // turning into files.
      host.innerHTML = renderDiffShell(file, { pending: true })
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
  region.addEventListener('click', (event) => {
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
      return
    }

    const gutterCell = target?.closest<HTMLElement>('.gutter.num[data-line]')
    if (gutterCell) {
      // Intercepted rather than followed: the browser would jump to a fragment
      // for a row that may not be mounted, and a shift-click has to extend
      // rather than navigate.
      event.preventDefault()
      selectLine(viewer.files()[Number(index)]?.path, gutterCell, event.shiftKey)
    }
  })

  /**
   * Select a line, or extend the selection to it.
   *
   * The selection lives in the URL, so it is the same thing as the link: what
   * the reader sees selected is exactly what they would send somebody.
   */
  function selectLine(path: string | undefined, cell: HTMLElement, extend: boolean): void {
    const line = Number(cell.dataset.line)
    const side = cell.dataset.side === 'left' ? 'left' : 'right'
    if (path == null || !Number.isFinite(line))
      return

    const clicked: LineAnchor = { path, side, from: line, to: line }

    // Extending only makes sense within one side of one file; across either,
    // the click starts a new selection instead of producing a range that spans
    // two things a comment could not be about.
    selection = extend && selection != null && selection.path === path && selection.side === side
      ? anchorBetween(selection, clicked)
      : clicked

    writeSelectionToUrl()
    paintSelection()
  }

  function writeSelectionToUrl(): void {
    const fragment = selection == null ? '' : formatLineAnchor(selection)
    // replaceState rather than assigning `location.hash`: the latter adds a
    // history entry per click, so leaving the page takes as many presses of
    // back as the reader made selections.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${fragment}`)
  }

  /**
   * Mark the selected lines in whatever is currently mounted.
   *
   * Re-applied after every frame as well as on change, because a row that
   * scrolled away and came back is a different element with none of the state.
   */
  function paintSelection(): void {
    for (const host of region.querySelectorAll<HTMLElement>('.diff-file-host')) {
      const path = host.dataset.path
      for (const cell of host.querySelectorAll<HTMLElement>('.gutter.num[data-line]')) {
        const line = Number(cell.dataset.line)
        const side = cell.dataset.side === 'left' ? 'left' : 'right'
        const on = path != null && selection != null && anchorCovers(selection, path, side, line)
        cell.closest('tr')?.classList.toggle('is-selected', on)
      }
    }
  }

  /**
   * How many rounds `revealSelection` will spend getting to a line.
   *
   * Each round can mount the file, wait for its rows, or expand one gap, so a
   * line buried under several collapsed gaps needs several. Bounded because
   * every one of those steps can legitimately fail - the line may not exist -
   * and a loop that kept trying would sit there fetching context forever.
   */
  const REVEAL_ROUNDS = 12

  /** Set while a reveal is in flight, so two links do not fight over the scroll. */
  let revealing = false

  /**
   * Bring the selected line into view.
   *
   * Four things can be in the way and each is handled by trying again rather
   * than by predicting it: the file may not have arrived yet (the manifest is
   * still streaming), it may be collapsed, its rows may not have been fetched,
   * and the line may sit in a gap between hunks that nothing has expanded. The
   * loop below does one of those per round and stops the moment the row exists.
   */
  async function revealSelection(): Promise<void> {
    if (selection == null || revealing)
      return

    revealing = true

    try {
      for (let round = 0; round < REVEAL_ROUNDS; round++) {
        const target = selection
        if (target == null)
          return

        const files = viewer.files()
        const index = files.findIndex(entry => entry.path === target.path)

        // Not in the list yet. Later batches will call this again, so give up
        // on this attempt rather than waiting on a file that may not be coming.
        if (index < 0)
          return

        if (files[index]!.collapsed) {
          viewer.setCollapsed(index, false)
          await nextFrame()
          continue
        }

        // Mounting it is what produces the rows to look for.
        viewer.scrollToFile(index)
        await nextFrame()

        const host = hostFor(index)
        if (host == null)
          continue

        const row = rowFor(host, target.side, target.from)
        if (row != null) {
          const offset = row.getBoundingClientRect().top - host.getBoundingClientRect().top
          viewer.scrollToFile(index, { offset, alignment: 'center' })
          paintSelection()
          return
        }

        // The rows are still on their way, or the line is inside a gap. Asking
        // for the gap is the only one of those this can act on.
        const control = expandControlCovering(host, target.from)
        if (control == null) {
          await nextFrame()
          continue
        }

        await expandGap(index, control)
      }
    }
    finally {
      revealing = false
    }
  }

  /** The mounted element for a file, if it is mounted. */
  function hostFor(index: number): HTMLElement | null {
    return region.querySelector<HTMLElement>(`.diff-file-host[data-file-index="${index}"]`)
  }

  /** The row carrying a line on a side, if it is rendered. */
  function rowFor(host: HTMLElement, side: 'left' | 'right', line: number): HTMLElement | null {
    const cell = host.querySelector<HTMLElement>(`.gutter.num[data-line="${line}"][data-side="${side}"]`)
    return cell?.closest('tr') ?? null
  }

  /**
   * The expansion control whose hidden range contains a line.
   *
   * Numbered against the new side, which is what the control's range is in.
   * A line on the old side of a gap is at a different number, and the offset
   * the control carries is exactly the difference - so the check is done in the
   * control's own numbering after undoing that offset.
   */
  function expandControlCovering(host: HTMLElement, line: number): HTMLElement | null {
    for (const control of host.querySelectorAll<HTMLElement>('.hunk-expand')) {
      const from = Number(control.dataset.expandFrom)
      const to = Number(control.dataset.expandTo)

      if (Number.isFinite(from) && Number.isFinite(to) && line >= from && line <= to)
        return control
    }

    return null
  }

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
    preferences.layout = layout
    writePreferences(preferences)
    showLayout()

    // The geometry switches immediately: the manifest carried the row counts
    // for both layouts, so the list knows every file's new height without
    // asking. Only the markup has to be fetched again.
    asked.clear()
    wanted.clear()
    viewer.setLayout(layout)
  })

  /**
   * Fold the whole review up, or open it out again.
   *
   * One button rather than two, because the reader can see which state the list
   * is in and a pair of buttons where one is always a no-op is a pair of
   * buttons to read. Collapsing keeps the scroll position because the viewer
   * anchors it, so this is a way to *skim* rather than a way to lose your place.
   */
  const collapseAllButton = document.querySelector<HTMLElement>('[data-diff-collapse-all]')
  let allCollapsed = false

  const showCollapseAll = () => {
    if (collapseAllButton) {
      collapseAllButton.textContent = allCollapsed ? 'Expand all' : 'Collapse all'
      collapseAllButton.setAttribute('aria-pressed', allCollapsed ? 'true' : 'false')
    }
  }

  collapseAllButton?.addEventListener('click', () => {
    allCollapsed = !allCollapsed
    viewer.collapseAll(allCollapsed)
    showCollapseAll()
  })

  showCollapseAll()

  /**
   * Moving without the mouse.
   *
   * A reviewer with eleven pull requests waiting does not want to aim at a
   * scrollbar. The keys are the ones every forge has trained people on, so
   * nobody has to learn ours: `j` and `k` for files, `n` and `p` for threads.
   *
   * Ignored while the reader is typing. A reply box is a text field, and `j`
   * in one means the letter j.
   */
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target))
      return

    const files = viewer.files()
    if (files.length === 0)
      return

    switch (event.key) {
      case 'j':
        event.preventDefault()
        goToFile(currentFile() + 1)
        break
      case 'k':
        event.preventDefault()
        goToFile(currentFile() - 1)
        break
      case 'n':
        event.preventDefault()
        goToThread(1)
        break
      case 'p':
        event.preventDefault()
        goToThread(-1)
        break
      default:
        break
    }
  })

  /** The file the reader is looking at: the first one at or below the top. */
  function currentFile(): number {
    const mounted = [...region.querySelectorAll<HTMLElement>('.diff-file-host')]
      .map(host => ({ index: Number(host.dataset.fileIndex), top: host.getBoundingClientRect().top }))
      .filter(entry => Number.isFinite(entry.index))
      .sort((a, b) => a.index - b.index)

    const edge = view.getBoundingClientRect().top
    // A tolerance, because the file at the top is usually a pixel or two above
    // it rather than exactly on it.
    const visible = mounted.find(entry => entry.top >= edge - 4)

    return visible?.index ?? mounted[mounted.length - 1]?.index ?? 0
  }

  function goToFile(index: number): void {
    const files = viewer.files()
    const clamped = Math.max(0, Math.min(index, files.length - 1))

    if (files[clamped]?.collapsed)
      viewer.setCollapsed(clamped, false)

    viewer.scrollToFile(clamped)
  }

  /**
   * The next conversation in either direction.
   *
   * Over what is mounted rather than over the whole diff, because a thread is
   * markup and only mounted files have any. Moving past the end of what is
   * mounted scrolls, which mounts more, so holding the key still walks the
   * whole review.
   */
  function goToThread(direction: 1 | -1): void {
    const threads = [...region.querySelectorAll<HTMLElement>('.thread')]
    if (threads.length === 0)
      return

    const edge = view.getBoundingClientRect().top
    const ordered = direction === 1 ? threads : [...threads].reverse()
    const next = ordered.find((thread) => {
      const offset = thread.getBoundingClientRect().top - edge
      return direction === 1 ? offset > 8 : offset < -8
    })

    next?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }

  // Somebody following a link within the page, or pressing back to a selection
  // they made earlier.
  window.addEventListener('hashchange', () => {
    selection = parseLineAnchor(window.location.hash)
    paintSelection()
    void revealSelection()
  })

  // The sidebar, if the page rendered a host for it.
  const listHost = document.querySelector<HTMLElement>('[data-diff-file-list]')
  const fileList = listHost
    ? createFileList({
        host: listHost,
        onSelect: (index) => {
          const file = viewer.files()[index]
          if (file?.collapsed)
            viewer.setCollapsed(index, false)
          viewer.scrollToFile(index)
        },
      })
    : null

  // Hung off the host so the benchmark harness can reach the viewer without a
  // global, and so a page with two of them would not have the second silently
  // overwrite the first. Nothing in the product reads this.
  ;(region.closest('[data-diff-stream]') as { __diffViewer?: DiffViewer } | null ?? {}).__diffViewer = viewer

  // Measured once and published as a custom property, so the split columns can
  // reserve the same width whether or not their pane happens to be scrolling.
  root.style.setProperty('--scrollbar-gutter', `${measureScrollbarGutter()}px`)

  showLayout()
  say('Loading the diff…')

  /**
   * The list beside the diff rebuilds on its own, slower schedule.
   *
   * Rebuilding it costs a pass over every file known so far, and during a
   * stream nobody is reading it - they are reading the first file, which
   * arrived before the sidebar had anything in it. Every thousand files or
   * every second is often enough that it never looks stuck, and rare enough
   * that a forty thousand file compare rebuilds it forty times rather than
   * sixteen hundred.
   */
  const TREE_EVERY_FILES = 1000
  const TREE_EVERY_MS = 1000
  let treeAt = 0
  let treeTime = performance.now()

  const refreshFileList = (force = false) => {
    const files = viewer.files()
    const now = performance.now()

    if (!force && files.length - treeAt < TREE_EVERY_FILES && now - treeTime < TREE_EVERY_MS)
      return

    treeAt = files.length
    treeTime = now
    fileList?.setFiles(files)
  }

  void streamDiffManifest(manifestUrl, {
    onFiles(files) {
      viewer.addFiles(files)
      refreshFileList()
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
      // Reached once the whole list is known, which is the earliest a link to a
      // file near the end can be honoured.
      refreshFileList(true)
      void revealSelection()
      const counts = `${summary.files} files, +${summary.additions} -${summary.deletions}`
      say(truncatedFrom == null ? counts : `${counts} (rendered to file ${truncatedFrom})`, 'done')
    },
    onError(message) {
      refreshFileList(true)
      say(message, 'error')
    },
  }, undefined, {
    // Measured from the scroll region the viewer actually owns, and read now
    // rather than captured earlier: the page has laid out by the time this
    // runs, so this is a real height and not a guess about one.
    firstBatchSize: firstBatchSize(view.clientHeight, DEFAULT_HEIGHT_METRICS.lineHeight),
  }).catch((error: unknown) => {
    say(error instanceof Error ? error.message : 'The diff could not be loaded.', 'error')
  })

  return viewer
}

/** Escape text for the placeholder, which is the only markup built here. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
