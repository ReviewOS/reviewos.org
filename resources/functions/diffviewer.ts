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
import { captureAnchor, DEFAULT_OVERSCAN, planFrame } from '../../app/Actions/Pull/viewport'

/**
 * How many hosts to keep for reuse.
 *
 * A screen's worth plus the overscan either side, with room to spare. Beyond
 * that the pool is holding elements nobody is going to ask for.
 */
const POOL_LIMIT = 64

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
      batch.push(record as unknown as DiffFileEntry)

      if (batch.length >= MANIFEST_BATCH_SIZE || performance.now() - lastFlush >= MANIFEST_BATCH_MS)
        flush()
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
