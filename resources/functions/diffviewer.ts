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
  appendPositions,
  captureAnchor,
  DEFAULT_OVERSCAN,
  identityScrollSpace,
  type ListItem,
  measuredLayout,
  planFrame,
  positionsByKey,
  reconcileList,
  type ScrollAlignment,
  scrollBehaviourFor,
  type ScrollSpace,
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
import { mechanicalLabel, renderDiffHeader, renderDiffShell } from '../../app/Actions/Pull/shell'
import {
  needsWindow,
  type RowWindow,
  shouldWindow,
  spacers,
  visibleRows,
  windowFor,
} from '../../app/Actions/Pull/window'
import type { ReviewStore } from './reviewstate'
import { writeHeaders } from './csrf'
import { filterFiles } from './filelist'
import { createReviewStore } from './reviewstate'

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
    ...(typeof record.mechanical === 'string' ? { mechanical: record.mechanical } : {}),
    ...(Array.isArray(record.folds) ? { folds: record.folds as DiffFileEntry['folds'] } : {}),
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
  /**
   * Where the viewed set is remembered, which is one pull request.
   *
   * Passed in rather than built here, because this function knows about files
   * and not about how a pull request is addressed or where a reader's progress
   * is kept. Absent on a page with nowhere to keep it, and then the ticks last
   * as long as the page does.
   */
  store?: ReviewStore | null
  /** Called when a file is ticked or unticked, so the diff can fold it away. */
  onViewedChange?: (path: string, viewed: boolean) => void
}): {
  setFiles: (files: readonly DiffFileEntry[]) => void
  setCurrent: (index: number) => void
  /** The paths the reader has marked as read. */
  viewed: () => ReadonlySet<string>
  /** Open the search field and put the cursor in it. */
  focusSearch: () => void
  /**
   * Show only these paths, or null for all of them.
   *
   * Composes with the search rather than replacing it, and leaves the positions
   * alone: a restricted list still addresses the diff by the number the diff
   * uses, so selecting a file still scrolls to the right one.
   */
  setRestriction: (paths: ReadonlySet<string> | null, label?: string) => void
  /**
   * Mark ticks that no longer describe the file, and ticks nobody can check.
   *
   * Shown rather than cleared. A tick is a reviewer's own record of what they
   * have read, and unticking it for them throws away the one thing they cannot
   * reconstruct - which of two hundred files they had got through. Saying "this
   * one moved" leaves the decision where it belongs.
   */
  setStale: (stale: ReadonlySet<string>, unverifiable?: ReadonlySet<string>) => void
  destroy: () => void
} {
  const { host, onSelect, store, onViewedChange } = options

  const header = document.createElement('div')
  const viewport = document.createElement('div')
  const sizer = document.createElement('div')
  const rows = document.createElement('div')

  header.className = 'file-list-head'
  header.innerHTML = `<span class="file-list-count muted"></span>`
    + `<button type="button" class="file-list-search-toggle" aria-expanded="false"`
    + ` aria-label="Search the files"><span class="i-hugeicons-search-01" aria-hidden="true"></span></button>`
    + `<input type="search" class="file-list-search" placeholder="Filter files" hidden>`

  viewport.className = 'file-list-viewport'
  sizer.className = 'file-list-sizer'
  rows.className = 'file-list-rows'
  sizer.appendChild(rows)
  viewport.appendChild(sizer)
  host.appendChild(header)
  host.appendChild(viewport)

  const search = header.querySelector<HTMLInputElement>('.file-list-search')!
  const searchToggle = header.querySelector<HTMLElement>('.file-list-search-toggle')!
  const count = header.querySelector<HTMLElement>('.file-list-count')!

  let files: readonly DiffFileEntry[] = []
  /*
   * The diff's numbering, translated to this list's.
   *
   * The rows and the filter work in positions - a sidebar is a virtualized list
   * like any other - and everything crossing this boundary speaks the number
   * the diff uses, because that is what the viewer beside it answers to. Equal
   * while the list is the whole diff in order, and not equal the moment either
   * side shows a subset.
   */
  let positions = new Map<number, number>()

  function fileFor(index: number): DiffFileEntry | undefined {
    const position = positions.get(index)

    return position == null ? undefined : files[position]
  }
  // The positions that survive the current filter, in diff order. Positions
  // rather than files, so everything downstream still addresses the diff by
  // the number it uses.
  let shown: number[] = []
  let current = -1
  /*
   * The two ways a tick can have stopped meaning what it said, held together
   * because they are answered together and read together. One object rather
   * than two bindings: the linter reads an assignment inside the returned
   * methods as no assignment at all and asks for `const`, which the next person
   * would take and then wonder why marking never worked.
   */
  const marks: { stale: ReadonlySet<string>, unverifiable: ReadonlySet<string> } = {
    stale: new Set(),
    unverifiable: new Set(),
  }
  let frame: number | null = null
  /** Set while the list is narrowed to a subset, null when it shows everything. */
  let restriction: ReadonlySet<string> | null = null
  let restrictionLabel = ''
  // Mutated, never replaced: the list holds a reference to it, and so does the
  // store, which is what lets the server's answer land in it without either
  // side handing the other a new Set.
  const viewed: ReadonlySet<string> = store?.viewed ?? new Set<string>()

  const schedule = () => {
    if (frame == null)
      frame = requestAnimationFrame(() => { frame = null; paint() })
  }

  function refilter(): void {
    shown = filterFiles(files, search.value, restriction)
    positions = positionsByKey(files.map(file => file.index))
  }

  /** How many files the reader has left to read, said plainly. */
  function paintCount(): void {
    const read = files.filter(file => viewed.has(file.path)).length
    const filtered = shown.length !== files.length ? `${shown.length} of ` : ''

    // Said out loud, always. Folding the mechanical files without a count is
    // the one thing this must not do: a reviewer who is told "eleven hunks
    // hidden, all formatting" can open them, and a reviewer silently shown less
    // has been lied to about the size of what they approved.
    const mechanical = files.filter(file => file.mechanical).length
    const skippable = mechanical === 0 ? '' : `, ${mechanical} mechanical`

    const base = read === 0
      ? `${filtered}${files.length} files${skippable}`
      : `${filtered}${files.length} files, ${read} viewed${skippable}`

    // The reason a list is short has to be visible, or a reviewer with eleven
    // files in front of them concludes the pull request is eleven files and
    // approves it. `2 of 3` says it is narrowed; the label says by what, and is
    // only worth the room when nothing else on screen does - the "since you
    // looked" control sits directly above the list in its pressed state and
    // says so already, so it passes none and this stays one line.
    count.textContent = restriction != null && restrictionLabel
      ? `${base} · ${restrictionLabel}`
      : base
  }

  function paint(): void {
    const height = viewport.clientHeight || 1
    sizer.style.height = `${shown.length * FILE_ROW_HEIGHT}px`
    paintCount()

    const first = Math.max(0, Math.floor((viewport.scrollTop - FILE_LIST_OVERSCAN) / FILE_ROW_HEIGHT))
    const last = Math.min(
      shown.length,
      Math.ceil((viewport.scrollTop + height + FILE_LIST_OVERSCAN) / FILE_ROW_HEIGHT),
    )

    rows.style.transform = `translateY(${first * FILE_ROW_HEIGHT}px)`
    // Sliced, never materialized: a screenful is rendered from a window into
    // the list rather than from a copy of it, whatever the diff's size.
    rows.innerHTML = shown.slice(first, last).map((index) => {
      const file = files[index]!
      const cut = file.path.lastIndexOf('/')
      const directory = cut < 0 ? '' : file.path.slice(0, cut + 1)
      const name = cut < 0 ? file.path : file.path.slice(cut + 1)
      const isViewed = viewed.has(file.path)
      // Only a ticked file can have a stale tick, and a file the reader has
      // since unticked is a file they are already going to read.
      const isStale = isViewed && marks.stale.has(file.path)
      const isUnverifiable = isViewed && !isStale && marks.unverifiable.has(file.path)
      const staleWhy = isStale
        ? ' - changed since you read it'
        : isUnverifiable ? ' - cannot tell whether it changed since you read it' : ''

      // The reason is on the row's tooltip as well as in the header, because
      // the sidebar is where a reviewer decides what to open and the header is
      // only visible once they have.
      const why = file.mechanical ? ` (${mechanicalLabel(file.mechanical)})` : ''

      return `<div class="file-row${file.index === current ? ' is-current' : ''}${isViewed ? ' is-viewed' : ''}`
        + `${isStale ? ' is-stale' : ''}${isUnverifiable ? ' is-unverifiable' : ''}`
        + `${file.mechanical ? ' is-mechanical' : ''}">`
        + `<input type="checkbox" class="file-viewed" data-file-index="${file.index}"`
        + ` aria-label="Mark ${escapeAttribute(file.path)} as viewed"${isViewed ? ' checked' : ''}>`
        + `<button type="button" class="file-open" data-file-index="${file.index}"`
        + ` title="${escapeAttribute(file.path)}${escapeAttribute(why)}${escapeAttribute(staleWhy)}">`
        + `<span class="file-status file-status-${escapeAttribute(file.status)}" aria-hidden="true"></span>`
        + `<span class="file-name">`
        + (directory ? `<span class="file-dir">${escapeText(directory)}</span>` : '')
        + `${escapeText(name)}</span>`
        + `<span class="file-counts mono"><span class="count-add">+${file.additions}</span>`
        + `<span class="count-del">-${file.deletions}</span></span></button></div>`
    }).join('')
  }

  const onScroll = () => schedule()
  viewport.addEventListener('scroll', onScroll, { passive: true })

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null
    const open = target?.closest<HTMLElement>('.file-open')
    if (open?.dataset.fileIndex != null)
      onSelect(Number(open.dataset.fileIndex))
  }
  viewport.addEventListener('click', onClick)

  const onChange = (event: Event) => {
    const box = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.file-viewed')
    const index = box?.dataset.fileIndex
    const file = index == null ? undefined : fileFor(Number(index))
    if (box == null || file == null)
      return

    store?.setViewed(file.path, box.checked)

    onViewedChange?.(file.path, box.checked)
    schedule()
  }
  viewport.addEventListener('change', onChange)

  // The server's answer arriving after the page has already painted from local
  // storage. Repainting is enough: the set it paints from is the one the store
  // just filled in, and the boxes are rendered from it on every frame.
  store?.subscribe((what) => {
    if (what === 'viewed')
      schedule()
  })

  /**
   * The filter opens only when it is asked for.
   *
   * A search field sitting above the list costs a row of vertical space on
   * every review, and the list it filters is usually short enough to read. It
   * earns its place on the compare that is four thousand files long, and that
   * is when the reader reaches for it.
   */
  const toggleSearch = (open: boolean) => {
    search.hidden = !open
    searchToggle.setAttribute('aria-expanded', open ? 'true' : 'false')

    if (open) {
      search.focus()
    }
    else if (search.value !== '') {
      search.value = ''
      refilter()
      schedule()
    }
  }

  searchToggle.addEventListener('click', () => toggleSearch(search.hidden === true))
  search.addEventListener('input', () => { refilter(); viewport.scrollTop = 0; schedule() })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape')
      toggleSearch(false)
  })

  return {
    setFiles(next) {
      files = next
      refilter()
      schedule()
    },
    setCurrent(index) {
      if (index === current)
        return

      current = index
      schedule()

      // Follow the reader down the diff, but only when the row would otherwise
      // be off screen: scrolling a sidebar somebody is reading is worse than
      // letting them lose their place in it. Measured in the *filtered* list,
      // because that is what is on screen.
      const position = positions.get(index)
      const row = position == null ? -1 : shown.indexOf(position)
      if (row < 0)
        return

      const top = row * FILE_ROW_HEIGHT
      const bottom = top + FILE_ROW_HEIGHT
      if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight)
        viewport.scrollTop = top - viewport.clientHeight / 3
    },
    viewed: () => viewed,
    /*
     * Which ticks have stopped being true, and which cannot be checked.
     *
     * Declared on the returned type and called from the loader below, and never
     * defined - so `fileList.setStale(...)` threw `setStale is not a function`
     * and the whole "a tick that has stopped being true says so" feature was
     * dead. Everything else it needs was already here: `marks` holds the state
     * and the row renderer reads it.
     *
     * Nothing is unticked. A tick is a reviewer's own record of what they have
     * read, and clearing it for them throws away the one thing they cannot
     * reconstruct - which of two hundred files they had got through. Saying
     * "this one moved" leaves the decision where it belongs.
     */
    setStale(stale, unverifiable = new Set()) {
      marks.stale = stale
      marks.unverifiable = unverifiable
      schedule()
    },
    focusSearch: () => toggleSearch(true),
    setRestriction(paths, label = '') {
      restriction = paths
      restrictionLabel = label
      refilter()
      viewport.scrollTop = 0
      schedule()
    },
    destroy() {
      if (frame != null)
        cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('click', onClick)
      viewport.removeEventListener('change', onChange)
      header.remove()
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

/**
 * Headers this viewer's own requests carry, beyond `Accept`.
 *
 * One case, and it is the public front door: a reader opening somebody else's
 * private diff supplies a GitHub token, and the manifest and row requests have
 * to carry it as an `Authorization` header. Not in the URL - every proxy
 * between the browser and this server logs query strings, and a personal access
 * token in a log file outlives the request by months.
 *
 * A module variable rather than an option threaded through four call sites,
 * because it is set once before mounting and never varies per request. It is
 * deliberately not put in the DOM: the token lives in this browser's storage
 * and in the header, and nowhere a page scrape would find it.
 */
let requestHeaders: Record<string, string> = {}

export function setDiffRequestHeaders(headers: Record<string, string>): void {
  requestHeaders = { ...headers }
}

/** `Accept`, plus whatever this viewer has been told to carry. */
function accepting(type: string): Record<string, string> {
  return { ...requestHeaders, Accept: type }
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

    // Guarded rather than assumed. `requestAnimationFrame` is the better of the
    // two - it yields until the browser has painted - but it does not exist
    // everywhere this module is loaded, and calling it where it is missing
    // throws *before* the timeout below can act as the fallback it was written
    // to be. The race only works if both sides are optional.
    if (typeof requestAnimationFrame === 'function')
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
  /**
   * Why this file needs no line by line reading, when the server could say so.
   *
   * Shown rather than merely acted on. A folded file with a stated reason is a
   * claim the reviewer can check by opening it; a folded file with no reason is
   * a request to trust something nobody said out loud.
   */
  mechanical?: string
  /**
   * The hunks folded by default, and the rows each hides. The manifest's
   * `rows` above is the effective (folded) count; unfolding adds these back.
   */
  folds?: Array<{ hunk: number, rows: RowCounts }>
  /**
   * What this file *is*, for a list that changes rather than only grows.
   *
   * Defaults to the path, which is the right answer here: it is unique within a
   * diff and it survives a rename arriving late in a stream, because a rename
   * reports the new path and carries the old one in `from`.
   */
  id?: string
  /**
   * Bumped by whoever changes the file, so `setFiles` can tell a file that
   * moved from a file that moved *and* changed. Absent means zero; a caller
   * that never changes a file in place never has to think about it.
   */
  version?: number
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
   * Called for each mounted file during the frame's measuring pass.
   *
   * A seam for a caller that needs a measurement of its own, and it exists so
   * that caller does not have to take one *outside* the pass. Every synchronous
   * layout read outside the batched pass forces the browser to flush the writes
   * that came before it, which is exactly the interleaving the pass is arranged
   * to avoid - so a caller reading a height on its own, at what looks like a
   * harmless moment, is a scroll that stutters for reasons nothing in its own
   * code explains.
   *
   * Read here, act later. Anything written from this callback is a write in the
   * middle of the read pass and defeats the point of both.
   */
  onMeasure?: (index: number, host: HTMLElement) => void
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
  /**
   * Replace the list with another one, keeping whatever the two have in common.
   *
   * For the changes that are not appends. "Since I last looked" answers with a
   * different set of files, a push arriving mid-review changes which files
   * exist, and a filter shows a subset - and all three used to mean rebuilding
   * the viewer, which drops every measured height, every mounted element, and
   * the reader's place.
   *
   * Files are matched by `id` (their path, unless the caller says otherwise).
   * A file present in both keeps its element and its measured height; one whose
   * `version` moved keeps its element and is rendered again; one that is gone
   * has its element pooled; one that is new is left to the next frame, which is
   * what decides what is on screen. The reader's anchor follows its *file*, so
   * ten files arriving above them is not a page that jumps.
   *
   * Appending still goes through `addFiles`, which is O(what arrived) rather
   * than O(the whole list) - a manifest stream calls it once per batch and a
   * large compare has forty thousand files.
   */
  setFiles: (files: readonly DiffFileEntry[]) => void
  setLayout: (layout: 'unified' | 'split') => void
  setCollapsed: (index: number, collapsed: boolean) => void
  /**
   * Replace a file's row counts, because a fold opened and the file is
   * genuinely taller now. The same invalidation dance as setCollapsed: what
   * was measured was the other state.
   */
  setRows: (index: number, rows: RowCounts) => void
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
  /**
   * A file just got taller by a known amount, in place.
   *
   * Expanding a hunk inserts rows into markup already on screen. Clearing the
   * measurement and waiting for the next frame to take a new one works, but it
   * drops back to the *estimate* in between - which knows nothing about the
   * expansion - so the list shrinks for a frame and then grows again, and the
   * reader watches everything below jump twice. Adding the delta means the
   * layout is right immediately and the measurement only refines it.
   */
  growBy: (index: number, pixels: number) => void
  collapseAll: (collapsed: boolean) => void
  scrollToFile: (index: number, target?: ScrollToOptions) => void
  /** The files, in list order. */
  files: () => readonly DiffFileEntry[]
  /**
   * One file, by the number the diff calls it.
   *
   * The array `files()` returns is in *list* order, so indexing it directly is
   * only right while the list is the whole diff in order. This is the lookup
   * that stays right when it is not.
   */
  fileFor: (index: number) => DiffFileEntry | null
  /**
   * Where a file's top sits in the list, or null if there is no such file.
   *
   * For a caller that has to work out which *rows* of a file are on screen -
   * the inside of a very large one. Read from the layout rather than from the
   * element, so the answer is the same whether or not the file is mounted.
   */
  positionOf: (index: number) => number | null
  /**
   * Where in the diff the top of the viewport is.
   *
   * The same number as `scroller.scrollTop` for every diff a browser can
   * scroll whole, and not the same number past that - see `ScrollSpace`. A
   * caller comparing a position from `positionOf` against where the reader is
   * has to use this one, or it is comparing two different spaces and will be
   * wrong by the compression ratio.
   */
  contentTop: () => number
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
  const { scroller, content, renderFile, releaseFile, onVisibleChange, afterRender, onMeasure } = options

  const entries: DiffFileEntry[] = []
  /**
   * The diff's numbers, in list order, kept beside the entries.
   *
   * `appendPositions` wants the keys and `entries` holds objects, and mapping
   * one to the other per batch would put back exactly the pass over the whole
   * list that appending incrementally exists to avoid.
   */
  const entryKeys: number[] = []
  const geometry: ViewportFile[] = []
  const hosts = new Map<number, HTMLElement>()
  const pool: HTMLElement[] = []
  /*
   * The diff's numbering, translated to this list's.
   *
   * Every caller addresses a file by its index in the whole diff - the number
   * the manifest, the row fetches, the file tree and the selection all use -
   * and this list holds positions. The two are the same number while the list
   * is the whole diff in diff order, which is what an append-only stream
   * produces and is why nothing has needed this until now. A list showing a
   * subset breaks the equality at every call site at once, so the translation
   * is here, once.
   */
  let positions = new Map<number, number>()

  /**
   * The map between the reader's scrollbar and the diff, as of the last frame.
   *
   * The identity for every diff a browser can scroll whole, which is all of
   * them but the very largest. Held rather than recomputed at each call site,
   * so the places that read a scroll position and the places that write one
   * cannot come to disagree about which space they are in - which would be a
   * viewer that jumps somewhere else when a reader clicks a file.
   */
  let space: ScrollSpace = identityScrollSpace()

  /** Where in the diff the reader is, from where the scrollbar is. */
  function contentTopNow(): number {
    return space.toContent(scroller.scrollTop)
  }

  /** The position of a file, by the number the diff calls it. */
  function slotOf(index: number): number | undefined {
    return positions.get(index)
  }

  function reindex(): void {
    entryKeys.length = 0

    for (const entry of entries)
      entryKeys.push(entry.index)

    positions = positionsByKey(entryKeys)
  }

  /**
   * The same map, extended rather than rebuilt.
   *
   * Appending a batch does not move anything already in the list, so rebuilding
   * the whole map to add twenty-five entries is work proportional to the diff
   * rather than to the batch - and a manifest arrives as one batch per
   * twenty-five files, so that is the same work done three thousand times over
   * on a diff of eighty thousand.
   *
   * It is quadratic, and it is the reason a very large diff decelerates and
   * then stops: measured on Linux `v6.0...v7.0`, `positionsByKey` was 53% of
   * everything the main thread did, and by twenty-seven thousand files each
   * arriving batch was rebuilding a twenty-seven thousand entry map. The
   * arithmetic for the whole diff is about 125 million map insertions to
   * discover twenty-five new positions each time.
   *
   * `setFiles` still rebuilds, and has to: a reconcile can reorder, filter or
   * remove, and then every position after the first change is different. That
   * one is rare and bounded; this one is on the hot path of every large diff.
   */
  function indexAppended(from: number): void {
    appendPositions(positions, entryKeys, from)
  }

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

    space = result.space

    /*
     * The container is given a height the browser will actually honour, and the
     * files are placed relative to where the reader is rather than at their
     * absolute offsets.
     *
     * On every diff anybody reviews these are the same thing: `space` is the
     * identity, `contentTop` equals `scrollTop`, and each file lands at its own
     * offset exactly as it always did. They come apart only past the point
     * where a browser stops being able to scroll a box - see `ScrollSpace` -
     * and there this is what keeps the far end of the diff reachable at all,
     * rather than positioned inside a container that is no longer tall enough
     * to hold it.
     */
    const scrollNow = result.scrollTop ?? scroller.scrollTop

    content.style.height = `${result.space.scrollHeight}px`

    if (result.scrollTop != null) {
      writtenScrollTop = result.scrollTop
      scroller.scrollTop = result.scrollTop
    }

    for (const [index, host] of hosts)
      host.style.top = `${result.layout.offsets[index]! - result.contentTop + scrollNow}px`

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

      onMeasure?.(entries[index]?.index ?? index, host)
    }

    if (remeasured) {
      // In the diff's space, which is what an anchor is: a file and how far
      // into it the viewport starts.
      anchor = captureAnchor(result.layout, result.contentTop)
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

    const mountedSlots = [...hosts.keys()]
    if (onVisibleChange && mountedSlots.length > 0) {
      // Reported in the diff's numbering, like everything else this viewer
      // hands out: the file tree receives it and addresses the diff back.
      const first = entries[Math.min(...mountedSlots)]?.index
      const last = entries[Math.max(...mountedSlots)]?.index

      if (first != null && last != null)
        onVisibleChange(first, last + 1)
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
    // The diff's number rather than the position: everything that reads this
    // attribute passes it back into a method that expects the diff's number.
    host.dataset.fileIndex = String(entry.index)
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
        const frame = planFrame(
          geometry,
          new Set(hosts.keys()),
          { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
          { layout, overscan },
        )

        // From the frame's own `contentTop` rather than from `scrollTop`: a
        // viewport that changed height changed the map too, so the position the
        // scrollbar reports means something slightly different than it did a
        // moment ago.
        anchor = captureAnchor(frame.layout, frame.contentTop)
        for (const file of geometry)
          file.measured = undefined
        schedule()
      })

  scroller.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver?.observe(scroller)

  /** Take an anchor now, so a change that moves things can put the reader back. */
  /**
   * The list as identified items, for a reconcile.
   *
   * Built from the two arrays the viewer keeps rather than stored as a third:
   * `entries` is what a file *is* and `geometry` is what it *measures*, and a
   * third copy of the same list is a third thing to keep in step.
   */
  function listItems(): ListItem[] {
    return entries.map((entry, index) => ({
      id: entry.id ?? entry.path,
      version: entry.version ?? 0,
      rows: geometry[index]!.rows,
      collapsed: geometry[index]!.collapsed,
      measured: geometry[index]!.measured,
    }))
  }

  function anchorNow(): void {
    const frame = planFrame(
      geometry,
      new Set(hosts.keys()),
      { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
      { layout, overscan },
    )
    anchor = captureAnchor(frame.layout, frame.contentTop)
  }

  return {
    addFiles(files) {
      if (files.length === 0)
        return

      const from = entries.length

      for (const file of files) {
        entries.push(file)
        entryKeys.push(file.index)
        geometry.push({ rows: file.rows, collapsed: file.collapsed })
      }

      indexAppended(from)
      schedule()
    },

    setFiles(files) {
      const before = listItems()

      // Taken against the list as it stands: the anchor is an index into the
      // *old* list, and the plan is what moves it to the new one.
      anchorNow()

      const after: ListItem[] = files.map(file => ({
        id: file.id ?? file.path,
        version: file.version ?? 0,
        rows: file.rows,
        collapsed: file.collapsed,
      }))

      const plan = reconcileList(before, after, { mounted: new Set(hosts.keys()), anchor })

      // Released first, and by old index, while `hosts` still means what it
      // meant when the plan was made. Re-keying underneath a release would look
      // up the wrong element and leave the right one in the document forever.
      for (const index of plan.release)
        release(index)

      const moved = new Map<number, HTMLElement>()
      for (const { from, to } of plan.keep) {
        const host = hosts.get(from)
        if (host)
          moved.set(to, host)
      }

      for (const { from, to } of plan.rerender) {
        const host = hosts.get(from)
        if (host)
          moved.set(to, host)
      }

      hosts.clear()
      for (const [index, host] of moved)
        hosts.set(index, host)

      entries.length = 0
      /*
       * Appended rather than spread. `push(...files)` passes every file as an
       * argument, and an argument list has a ceiling in the tens of thousands -
       * so on a diff of eighty thousand files this is not slow, it is a
       * `RangeError` and a blank screen. The loop has no ceiling.
       */
      for (const file of files)
        entries.push(file)

      geometry.length = 0
      for (let index = 0; index < after.length; index++) {
        geometry.push({
          rows: after[index]!.rows,
          collapsed: after[index]!.collapsed,
          measured: plan.measured[index],
        })
      }

      reindex()

      // The hosts that survived are pointing at their file again, which matters
      // for anything reading `data-file-index` off an element - a selection, an
      // open comment box, the file tree's idea of what is on screen. The
      // attribute carries the diff's number, not the position, because that is
      // what every reader of it passes back in.
      for (const [slot, host] of hosts) {
        host.dataset.fileIndex = String(entries[slot]?.index ?? slot)
        host.dataset.path = entries[slot]?.path ?? ''
      }

      // Rendered after the remap, so a file whose content changed is drawn from
      // its new record rather than its old one.
      for (const { to } of plan.rerender) {
        const host = hosts.get(to)
        const entry = entries[to]
        if (host && entry)
          renderFile(entry, host)
      }

      anchor = plan.anchor
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
      const slot = slotOf(index)
      const file = slot == null ? undefined : geometry[slot]
      if (!file)
        return

      // Cleared rather than measured here: the next frame measures every
      // mounted file in one pass, and anchors the correction so nothing the
      // reader is looking at moves.
      file.measured = undefined
      anchor = captureAnchor(measuredLayout(geometry, { layout }), contentTopNow())
      schedule()
    },

    growBy(index, pixels) {
      const slot = slotOf(index)
      const file = slot == null ? undefined : geometry[slot]
      if (!file || slot == null || !(pixels > 0))
        return

      anchorNow()
      file.measured = (file.measured ?? measuredLayout(geometry, { layout }).heights[slot] ?? 0) + pixels
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
      const slot = slotOf(index)
      const host = slot == null ? undefined : hosts.get(slot)
      const entry = slot == null ? undefined : entries[slot]
      if (!host || !entry)
        return

      renderFile(entry, host)
      // Its height almost certainly changed, so the next frame measures it and
      // anchors the correction.
      schedule()
    },

    setCollapsed(index, collapsed) {
      const slot = slotOf(index)
      const entry = slot == null ? undefined : entries[slot]
      if (!entry || slot == null || entry.collapsed === collapsed)
        return

      anchorNow()
      entry.collapsed = collapsed
      geometry[slot]!.collapsed = collapsed
      // What it measured was the other state, and measurements now win over
      // estimates whether a file is folded or not.
      geometry[slot]!.measured = undefined

      // Re-rendered rather than hidden with CSS, so a collapsed file is not
      // holding the markup of the eight thousand lines it is not showing.
      if (hosts.has(slot))
        release(slot)

      schedule()
    },

    setRows(index, rows) {
      const slot = slotOf(index)
      const entry = slot == null ? undefined : entries[slot]
      if (!entry || slot == null)
        return

      anchorNow()
      entry.rows = rows
      geometry[slot]!.rows = rows
      // What it measured was the shorter file.
      geometry[slot]!.measured = undefined

      if (hosts.has(slot))
        release(slot)

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
      const slot = slotOf(index)
      if (slot == null)
        return

      const frame = planFrame(
        geometry,
        new Set(hosts.keys()),
        { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
        { layout, overscan },
      )

      // The frame's map, so the answer comes back in the space the two writes
      // below put it into. Without it, "scroll to the last file" of a diff too
      // tall for the browser asks for a position several times past the end of
      // the scrollbar, and the browser lands wherever it can.
      const top = scrollTargetFor(frame.layout, scroller.clientHeight, { ...target, index: slot }, frame.space)
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

    fileFor(index) {
      const slot = slotOf(index)

      return slot == null ? null : entries[slot] ?? null
    },

    positionOf(index) {
      const slot = slotOf(index)

      return slot == null ? null : measuredLayout(geometry, { layout }).offsets[slot] ?? null
    },

    contentTop() {
      return contentTopNow()
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
/** A gap between hunks, as its expand control describes it. */
export interface HunkGap {
  /** First hidden line, in the new side's numbering. */
  from: number
  /** Last hidden line, in the new side's numbering. */
  to: number
  /** `newStart - oldStart` for the hunk below the gap. */
  offset: number
}

/**
 * Which gap hides a line, or -1.
 *
 * A gap's range is in the **new** side's numbering, because that is what the
 * server renders it from. A line on the old side sits at a different number,
 * and the offset the control carries is exactly the difference - so an old-side
 * line has to be moved into the control's numbering before it is compared.
 *
 * Not doing that is a bug with no symptom at the point of failure: nothing
 * throws and nothing is logged, the reveal loop simply never finds a gap to
 * expand, spends its rounds, and gives up. A reader following a link to a
 * removed line inside a collapsed region gets a page that does nothing, which
 * reads as a dead link rather than as a diff that has not been expanded yet.
 *
 * Separated from the DOM so the arithmetic can be tested, which is where the
 * side and the offset are: the element lookup around it has nothing to get
 * wrong.
 */
export function gapCovering(
  gaps: readonly HunkGap[],
  side: 'left' | 'right',
  line: number,
): number {
  for (let index = 0; index < gaps.length; index++) {
    const gap = gaps[index]!
    if (!Number.isFinite(gap.from) || !Number.isFinite(gap.to))
      continue

    // The old side is numbered `offset` behind the new one.
    const probe = side === 'left'
      ? line + (Number.isFinite(gap.offset) ? gap.offset : 0)
      : line

    if (probe >= gap.from && probe <= gap.to)
      return index
  }

  return -1
}

/**
 * What to tell the reader when the manifest request fails.
 *
 * Not the response body. A failure here is JSON from our own error handler -
 * `{"success":false,"message":"Not Found","path":"/api/repos/pulls/diff/manifest","request_id":…}` -
 * and the status line writes whatever string it is given, so that lands in the
 * middle of the page: a route, a method and a request id where a sentence
 * should be, in the one place somebody came to read code. It can also be a
 * proxy's HTML error page, which is the same failure with more of it.
 *
 * The body is still worth reading rather than discarding. Our own handler puts
 * a usable sentence in `message`, so that wins when there is one; `Not Found`
 * is the status repeated back and explains nothing, so it does not.
 */
export async function describeFailure(response: Response): Promise<string> {
  const fallback = response.status === 404
    ? 'This diff is no longer available. It may have been rebased away, or the pull request removed.'
    : `The diff could not be loaded (${response.status}).`

  let body = ''
  try {
    body = await response.text()
  }
  catch {
    return fallback
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const message = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string' ? parsed.error : ''

    // Length-capped because a sentence is the point: a stack trace or a page
    // of text in `message` is the raw-body problem wearing a field name.
    if (message && message.length <= 200 && message.trim().toLowerCase() !== 'not found')
      return message
  }
  catch {
    // Not JSON at all - an HTML error page from a proxy, or plain text. There
    // is nothing in it worth putting on the page.
  }

  return fallback
}

export async function streamDiffManifest(
  url: string,
  handlers: ManifestStreamHandlers,
  signal?: AbortSignal,
  options: ManifestStreamOptions = {},
): Promise<void> {
  const response = await fetch(url, { signal, headers: accepting('application/x-ndjson') })

  if (!response.ok) {
    handlers.onError?.(await describeFailure(response))
    return
  }

  const firstSize = options.firstBatchSize ?? FIRST_BATCH_MIN
  let batch: DiffFileEntry[] = []
  let published = 0

  /*
   * The batch clock starts at the first record, not at the request.
   *
   * It used to start here, which is before the server has said anything, and on
   * a diff that git takes seconds to compute that quietly inverted the whole
   * cadence: by the time the first record arrived, the batch window had long
   * since elapsed, so the first flush went out carrying **one file**. The first
   * screen - the one this ceiling exists to fill - was a single file, and the
   * rest arrived underneath it while the reader watched, which is precisely the
   * failure the comment on `FIRST_BATCH_MS` describes.
   *
   * Measured on Linux `v6.0...v7.0`, where git needs 7.5 seconds before the
   * first record exists. A twelve-file pull request never showed it, because
   * there the first record arrives inside the window and the old code and this
   * one behave identically.
   *
   * Null until then, so "no records yet" is a state rather than a timestamp
   * that happens to be old.
   */
  let lastFlush: number | null = null
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
      // The first record starts the clock, so the window is measured from when
      // the server began answering rather than from when it was asked.
      lastFlush ??= performance.now()

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
/**
 * Markup the server already rendered for a file, if it is still the right shape.
 *
 * The first screen is not fetched. The server parses the diff once to build the
 * manifest and renders the first files' rows while it is there, and those
 * arrive on the same stream as the file records - so by the time the viewer
 * lays out file three, file three's rows are usually already in hand. Using
 * them verbatim is the point: the rows above the fold are then *the same
 * markup* as the rows below it, rather than a second rendering that has to be
 * kept in step with the first.
 *
 * Tagged with the layout each was rendered in, because rows arrive as markup
 * rather than as data. A file cached unified is of no use in split and has to
 * be asked for again - per file, since a reader may switch back before the
 * whole list has been refetched.
 *
 * Split out of `renderFile` so the property can be asserted without a DOM:
 * "what the server sent is what is shown" is the claim, and it was three lines
 * inside a callback that needs a browser to reach.
 */
export function serverMarkup(
  cache: ReadonlyMap<number, { html: string, layout: 'unified' | 'split' }>,
  index: number,
  layout: 'unified' | 'split',
): string | null {
  const cached = cache.get(index)

  return cached != null && cached.layout === layout ? cached.html : null
}

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
  const commentUrl = root.dataset.commentUrl
  const sinceUrl = root.dataset.sinceUrl
  const staleUrl = root.dataset.staleUrl
  const interdiffUrl = root.dataset.interdiffUrl
  const blameUrl = root.dataset.blameUrl

  /**
   * Paths whose proposal changed since the reader last looked, once known.
   * The interdiff button is painted onto exactly these files' headers -
   * painted, not baked in, because hosts are recycled and re-rendered from
   * cached markup.
   */
  let sinceChanged: Set<string> | null = null
  /*
   * Every file the manifest has sent, which is not the same as every file the
   * list is showing.
   *
   * The viewer holds what is on screen; restricting it to the files that moved
   * since the reader last looked means the rest have to be kept somewhere to
   * come back to. Kept here rather than re-fetched: the manifest is the
   * expensive part of opening a large diff, and a filter is not a reason to ask
   * for it again.
   */
  const allFiles: DiffFileEntry[] = []
  /** The paths the list is narrowed to, or null when it shows the whole diff. */
  let restriction: ReadonlySet<string> | null = null

  /**
   * Where the reader's progress through this pull request is kept.
   *
   * Local storage first and always, so a tick survives a reload pressed a
   * moment later; the server behind it, so it survives a different machine.
   * Scoped by the manifest url, which already names the repository and the
   * number and is the same for every reader of this page.
   *
   * A page that did not render the endpoints - an older template, or a surface
   * that shows a diff without a pull request behind it - gets a local-only
   * store rather than a second code path.
   */
  const reviewStore = createReviewStore({
    scope: manifestUrl,
    endpoints: root.dataset.stateUrl && root.dataset.viewedUrl && root.dataset.draftUrl
      ? { state: root.dataset.stateUrl, viewed: root.dataset.viewedUrl, draft: root.dataset.draftUrl }
      : null,
  })

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
          if (changed === 'wrap') {
            // Including what a windowed file's rows measure, which is the whole
            // reason that figure exists. Dropped rather than adjusted: the next
            // frame measures it again, and a stale height here would size the
            // spacers and choose the window off the previous wrap setting.
            rowHeights.clear()
            viewer.remeasureAll()
          }
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

  /**
   * Files too large to put in the document at once.
   *
   * The list virtualizes files; this virtualizes the inside of one. A file of
   * four hundred thousand lines is a single item to the list, so without this
   * it mounts whole - four hundred thousand table rows in one document, which
   * is the failure the whole engine exists to avoid.
   *
   * What is held per file: the window of rows in hand, its markup, and whether
   * a request for another is already out. Nothing else - the rest of the file
   * is two spacers and a number.
   */
  const windows = new Map<number, {
    held: RowWindow | null
    html: string
    layout: 'unified' | 'split'
    pending: RowWindow | null
  }>()

  /**
   * What a row of a windowed file actually measures, once one has been seen.
   *
   * The metric line height is the estimate every windowed file starts on, and
   * it is right for the common case: one row, one line. With word wrap on it is
   * wrong by however many lines a row wrapped to, and the error is not confined
   * to an inexact scrollbar. The same number decides *which* rows to fetch, so
   * an estimate that says rows are half their real height reports twice as many
   * on screen as there are and centres the next window below where the reader
   * is - which costs them the rows they were reading, not just a scrollbar that
   * lies a little.
   *
   * So both uses take the same number, and it becomes a measurement as soon as
   * there is one. Measured from the rows themselves with the spacers subtracted
   * out, which is what keeps this from feeding back on itself: the spacers are
   * sized *from* this figure, so a figure derived from them would chase its own
   * tail every frame.
   */
  const rowHeights = new Map<number, number>()

  function rowHeightFor(index: number): number {
    return rowHeights.get(index) ?? DEFAULT_HEIGHT_METRICS.lineHeight
  }

  /** How many rows a file has in the layout being shown. */
  function rowCount(file: DiffFileEntry): number {
    return layout === 'split' ? file.rows.split : file.rows.unified
  }

  /** Whether this file is shown a window at a time. */
  function windowed(file: DiffFileEntry): boolean {
    return !file.collapsed && rowsUrl != null && shouldWindow(rowCount(file))
  }

  // Files mounted without markup, waiting to be asked for, and the ones already
  // asked for. Two sets rather than one, so a slow response does not make the
  // viewer ask again on every frame the file stays on screen.
  const wanted = new Set<number>()
  const asked = new Set<number>()

  /**
   * Default-folded hunks the reader has opened, per file. Joined into every
   * rows request for the file, so the server renders and this side counts
   * over the same fold set - the drift between them would be whole hunks of
   * numbering.
   */
  const openFolds = new Map<number, Set<number>>()

  /** The `open` query value for one file, or null when nothing is open. */
  function openParam(index: number): string | null {
    const opened = openFolds.get(index)
    return opened && opened.size > 0 ? [...opened].sort((a, b) => a - b).join(',') : null
  }

  /**
   * Open one default-folded hunk: the file is genuinely taller now, its
   * cached markup describes the shorter file, and the next fetch has to say
   * which hunks the reader opened.
   */
  function openFold(index: number, hunk: number): void {
    const file = viewer.fileFor(index)
    const fold = file?.folds?.find(entry => entry.hunk === hunk)
    if (!file || !fold)
      return

    const opened = openFolds.get(index) ?? new Set<number>()
    if (opened.has(hunk))
      return

    opened.add(hunk)
    openFolds.set(index, opened)

    viewer.setRows(index, {
      unified: file.rows.unified + fold.rows.unified,
      split: file.rows.split + fold.rows.split,
    })

    // The markup in hand is the folded file; the windows and measurements
    // are its geometry. All of it describes a file that no longer exists.
    markup.delete(index)
    windows.delete(index)
    asked.delete(index)
    wanted.add(index)
    scheduleRowFetch()
  }
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
    afterRender: () => {
      paintSelection()
      paintDraft()
      paintSelectionSurface()
      paintInterdiffOffers()

      // A windowed file needs a different window as the reader moves through
      // it, and moving through it does not mount or unmount anything - so the
      // frame is the only place that notices.
      for (const host of region.querySelectorAll<HTMLElement>('.diff-file-host'))
        scheduleWindowFetch(Number(host.dataset.fileIndex))
    },
    // The sidebar follows the diff rather than the other way round, so the row
    // highlighted is the file the reader is actually looking at.
    onVisibleChange: start => fileList?.setCurrent(start),
    /**
     * What a row of this file really measures, taken while reads are batched.
     *
     * Only the rows in hand are measured: the spacers are subtracted out
     * because they are sized from the answer, and measuring them back into it
     * would make the figure chase itself. Reads only - what it learns is used
     * on a later frame.
     */
    onMeasure(index, host) {
      const file = viewer.fileFor(index)
      const held = windows.get(index)?.held
      if (file == null || held == null || !windowed(file))
        return

      const rows = held.to - held.from
      const body = host.querySelector<HTMLElement>('.diff-table tbody')
      if (rows <= 0 || body == null)
        return

      let spacing = 0
      for (const spacer of body.querySelectorAll<HTMLElement>(':scope > .row-spacer'))
        spacing += spacer.offsetHeight

      const height = body.offsetHeight - spacing
      if (height > 0)
        rowHeights.set(index, height / rows)
    },
    renderFile(file, host) {
      // Folded up: the header and nothing else. No rows are asked for, because
      // the reader has not asked to see any, and a diff where every collapsed
      // lock file quietly fetches itself is a diff that collapses nothing.
      if (file.collapsed) {
        host.innerHTML = renderDiffShell(file, { collapsed: true })
        return
      }

      if (windowed(file)) {
        host.innerHTML = renderWindow(file)
        scheduleWindowFetch(file.index)
        return
      }

      const cached = serverMarkup(markup, file.index, layout)
      if (cached != null) {
        // Used exactly as it arrived. This is the first screen's whole story:
        // the server rendered these rows while it was already parsing the diff
        // to build the manifest, and using them verbatim is what keeps the
        // markup above the fold identical to the markup below it.
        host.innerHTML = cached
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
   * A windowed file: the rows in hand, and two spacers for the rest.
   *
   * The spacers are what keep the scrollbar honest. Without them the file would
   * be as tall as its window, and a reader would reach the end of a hundred
   * thousand line file in four screens.
   */
  function renderWindow(file: DiffFileEntry): string {
    const total = rowCount(file)
    const state = windows.get(file.index)
    const held = state != null && state.layout === layout ? state.held : null
    const rowHeight = rowHeightFor(file.index)
    const columns = layout === 'split' ? 4 : 3
    const { above, below } = held == null
      ? { above: 0, below: total * rowHeight }
      : spacers(held, total, rowHeight)

    const spacer = (height: number) => height <= 0
      ? ''
      : `<tr class="row-spacer" aria-hidden="true"><td colspan="${columns}" style="height:${height}px"></td></tr>`

    return `<section class="diff-file panel" id="file-${escapeAttribute(file.path)}">`
      + renderDiffHeader(file)
      + `<div id="body-${escapeAttribute(file.path)}" class="diff-body">`
      + `<table class="diff-table" data-columns="${columns}"><tbody>`
      + spacer(above)
      + (held == null ? '' : (state?.html ?? ''))
      + spacer(below)
      + `</tbody></table></div></section>`
  }

  /**
   * Ask for the window a windowed file needs, if it needs a different one.
   *
   * Where the file sits in the list is read from the viewer rather than from
   * the element, so this answers the same way whether or not the file happens
   * to be mounted at the moment.
   */
  function scheduleWindowFetch(index: number): void {
    const file = viewer.fileFor(index)
    if (file == null || !windowed(file) || rowsUrl == null)
      return

    const total = rowCount(file)
    const position = viewer.positionOf(index)
    if (position == null)
      return

    const visible = visibleRows({
      /*
       * Where the reader is *in the diff*, not where the scrollbar is.
       *
       * `positionOf` answers in the diff's own pixels, so the comparison has to
       * be made there. The viewport height is left alone deliberately: only
       * positions are remapped, never sizes - a file is rendered at its real
       * height whatever the scrollbar is doing, so the band on screen really is
       * `clientHeight` pixels of diff.
       */
      scrollTop: viewer.contentTop(),
      viewportHeight: view.clientHeight,
      // The rows start under the header.
      fileTop: position + DEFAULT_HEIGHT_METRICS.headerHeight,
      totalRows: total,
      rowHeight: rowHeightFor(index),
    })

    const state = windows.get(index)
    const held = state != null && state.layout === layout ? state.held : null
    if (!needsWindow(held, visible, total))
      return

    const wanted = windowFor(visible, total)
    if (state?.pending != null && state.pending.from === wanted.from && state.pending.to === wanted.to)
      return

    windows.set(index, {
      held,
      html: state?.layout === layout ? (state.html ?? '') : '',
      layout,
      pending: wanted,
    })

    void fetchWindow(index, file.path, wanted, layout)
  }

  async function fetchWindow(
    index: number,
    path: string,
    wanted: RowWindow,
    requested: 'unified' | 'split',
  ): Promise<void> {
    if (rowsUrl == null)
      return

    try {
      const query = new URLSearchParams({
        path,
        layout: requested,
        from: String(wanted.from),
        to: String(wanted.to),
      })

      // The reader's opened folds ride along, so the window's numbering is
      // over the same rows this side is counting.
      const opened = openParam(index)
      if (opened != null)
        query.set('open', opened)

      const response = await fetch(`${rowsUrl}&${query}`, { headers: accepting('application/x-ndjson') })
      if (!response.ok)
        throw new Error(await response.text())

      let html = ''
      for await (const record of readNdjson<Record<string, unknown>>(response)) {
        if (record.t === 'rows')
          html = String(record.html)
      }

      // Dropped when the reader switched layout while this was in flight: the
      // markup is real, and it is rows of the other shape.
      if (requested !== layout)
        return

      // The rows endpoint returns a whole file element; only its rows are
      // wanted here, because the header and the spacers are this side's.
      windows.set(index, { held: wanted, html: rowsOf(html), layout: requested, pending: null })
      viewer.refresh(index)
    }
    catch {
      const state = windows.get(index)
      if (state != null)
        windows.set(index, { ...state, pending: null })
    }
  }

  /** Fetch one file whole, with its opened folds named. */
  async function fetchOpenedFile(index: number, path: string): Promise<void> {
    if (rowsUrl == null)
      return

    try {
      const requested = layout
      const query = new URLSearchParams({ path, layout: requested })

      const opened = openParam(index)
      if (opened != null)
        query.set('open', opened)

      const response = await fetch(`${rowsUrl}&${query}`, { headers: accepting('application/x-ndjson') })
      if (!response.ok)
        throw new Error(await response.text())

      for await (const record of readNdjson<Record<string, unknown>>(response)) {
        if (record.t === 'rows' && requested === layout) {
          markup.set(index, { html: String(record.html), layout: requested })
          viewer.refresh(index)
        }
      }
    }
    catch {
      asked.delete(index)
    }
  }

  /** The `<tr>` rows out of a rendered file, without its header or table. */
  function rowsOf(html: string): string {
    const start = html.indexOf('<tbody>')
    const end = html.lastIndexOf('</tbody>')

    return start < 0 || end < 0 ? '' : html.slice(start + '<tbody>'.length, end)
  }

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

    const batch = [...wanted].slice(0, ROW_FETCH_BATCH)
    const query = new URLSearchParams()

    for (const index of batch) {
      wanted.delete(index)
      const file = viewer.fileFor(index)
      if (!file)
        continue

      // A file with opened folds needs its own request: `open` names hunks
      // within one file, and a batch would apply one file's openings to all.
      if (openParam(index) != null) {
        asked.add(index)
        void fetchOpenedFile(index, file.path)
        continue
      }

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
      const file = viewer.fileFor(index)
      if (file)
        indexByPath.set(file.path, index)
    }

    try {
      const requested = layout
      const response = await fetch(`${rowsUrl}&layout=${requested}&${query}`, {
        headers: accepting('application/x-ndjson'),
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
      const file = viewer.fileFor(Number(index))
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

    const unfold = target?.closest<HTMLElement>('.hunk-unfold')
    if (unfold) {
      event.preventDefault()
      openFold(Number(index), Number(unfold.dataset.hunk))
      return
    }

    const interdiff = target?.closest<HTMLElement>('.diff-interdiff-btn')
    if (interdiff) {
      event.preventDefault()
      void openInterdiff(Number(index), interdiff)
      return
    }

    const comment = target?.closest<HTMLElement>('.line-comment')
    if (comment) {
      event.preventDefault()
      const cell = comment.closest<HTMLElement>('.gutter.num[data-line]')
      const path = viewer.fileFor(Number(index))?.path
      if (cell != null && path != null) {
        // A comment started from a line that is already inside the selection is
        // about the selection: the reader picked a range and then asked to talk
        // about it. One started anywhere else is about that line alone.
        const line = Number(cell.dataset.line)
        const side = cell.dataset.side === 'left' ? 'left' : 'right'
        const covered = selection != null && anchorCovers(selection, path, side, line)

        openDraft(covered && selection != null ? selection : { path, side, from: line, to: line })
      }
      return
    }

    const gutterCell = target?.closest<HTMLElement>('.gutter.num[data-line]')
    if (gutterCell) {
      // Intercepted rather than followed: the browser would jump to a fragment
      // for a row that may not be mounted, and a shift-click has to extend
      // rather than navigate.
      event.preventDefault()
      selectLine(viewer.fileFor(Number(index))?.path, gutterCell, event.shiftKey)
    }
  })

  /**
   * Selecting a range by dragging down the gutter.
   *
   * Pointer events rather than mouse events, so a touch drag works the same
   * way, and captured on the region rather than per row because rows come and
   * go under the finger as the list scrolls.
   */
  let dragging: LineAnchor | null = null

  region.addEventListener('pointerdown', (event) => {
    if (event.button !== 0)
      return

    const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('.gutter.num[data-line]')
    const host = cell?.closest<HTMLElement>('.diff-file-host')
    const path = host?.dataset.path
    if (cell == null || path == null)
      return

    const line = Number(cell.dataset.line)
    const side = cell.dataset.side === 'left' ? 'left' : 'right'
    if (!Number.isFinite(line))
      return

    dragging = { path, side, from: line, to: line }
  })

  region.addEventListener('pointermove', (event) => {
    if (dragging == null)
      return

    const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('.gutter.num[data-line]')
    if (cell == null)
      return

    const line = Number(cell.dataset.line)
    const side = cell.dataset.side === 'left' ? 'left' : 'right'

    // A drag that wanders onto the other side of a split view, or onto another
    // file, is ignored rather than producing a range that spans two things a
    // comment could not be about.
    if (!Number.isFinite(line) || side !== dragging.side)
      return

    selection = anchorBetween(dragging, { ...dragging, from: line, to: line })
    writeSelectionToUrl()
    paintSelection()
    paintSelectionSurface()
  })

  window.addEventListener('pointerup', () => { dragging = null })

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
    paintSelectionSurface()
  }

  function writeSelectionToUrl(): void {
    const fragment = selection == null ? '' : formatLineAnchor(selection)
    // replaceState rather than assigning `location.hash`: the latter adds a
    // history entry per click, so leaving the page takes as many presses of
    // back as the reader made selections.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${fragment}`)
  }

  /**
   * The comment being written, if there is one.
   *
   * One at a time across the whole list, deliberately. Several half-written
   * comments scattered down a diff is a way to lose one, and the reader can
   * only be typing in a single place anyway.
   *
   * Held here rather than only in the DOM because the row it lives in is
   * recycled: scroll away from a draft and the element is gone, and without
   * this the words would be too. `text` is what makes it survive.
   */
  let draft: { anchor: LineAnchor, text: string, busy: boolean } | null = null

  /** Remember the draft as it is typed, so a reload does not cost the words. */
  function rememberDraft(): void {
    reviewStore.setDraft(draft == null ? null : { ...draft.anchor, text: draft.text })
  }

  /**
   * Put back a comment somebody started writing and did not send.
   *
   * Only once the file list is known, because the draft names a path and a
   * path means nothing until the manifest has said which files exist. A draft
   * for a file that is not in this diff any more - the branch moved under it -
   * is dropped rather than re-opened somewhere arbitrary.
   */
  function restoreDraft(): void {
    if (draft != null)
      return

    const stored = reviewStore.draft()
    if (stored == null || stored.text.trim() === '')
      return

    if (!viewer.files().some(file => file.path === stored.path)) {
      reviewStore.setDraft(null)
      return
    }

    openDraft({ path: stored.path, side: stored.side, from: stored.from, to: stored.to }, stored.text)
  }

  /** Open a draft on a line or a range, replacing whatever was open. */
  function openDraft(anchor: LineAnchor, text = ''): void {
    draft = { anchor, text, busy: false }
    rememberDraft()
    selection = anchor
    writeSelectionToUrl()
    paintSelection()
    paintDraft()

    // Painted and focused on the next frame as well as now. Now covers the
    // ordinary case, where the reader clicked a line that is plainly on
    // screen; the frame covers a draft being *restored* from storage, where
    // the file it belongs to has not been mounted yet and there is nothing to
    // insert the row after. Without it a restored draft was held in memory,
    // correctly, and never appeared - because after the stream ends nothing
    // schedules another frame and `afterRender` is where the painting happens.
    requestAnimationFrame(() => {
      paintDraft()
      region.querySelector<HTMLTextAreaElement>('.draft-input')?.focus()
    })
  }

  function closeDraft(): void {
    draft = null
    reviewStore.setDraft(null)

    for (const row of region.querySelectorAll('.draft-row'))
      row.remove()
  }

  /**
   * Put the draft row under the line it is about, wherever that line now is.
   *
   * Called after every frame, so a draft that scrolled off and came back is
   * restored into the new row with its text intact, and a draft whose file is
   * not mounted simply is not in the document.
   */
  function paintDraft(): void {
    const current = draft
    if (current == null)
      return

    const existing = region.querySelector<HTMLElement>('.draft-row')
    const host = region.querySelector<HTMLElement>(`.diff-file-host[data-path="${cssEscape(current.anchor.path)}"]`)
    const cell = host?.querySelector<HTMLElement>(
      `.gutter.num[data-line="${current.anchor.to}"][data-side="${current.anchor.side}"]`,
    )
    const row = cell?.closest('tr')

    if (row == null) {
      // The line is not rendered right now. The text is still held, so this is
      // a pause rather than a loss.
      existing?.remove()
      return
    }

    if (existing != null && existing.previousElementSibling === row)
      return

    existing?.remove()

    const columns = row.closest('table')?.dataset.columns === '4' ? 4 : 3
    const lines = current.anchor.from === current.anchor.to
      ? `line ${current.anchor.to}`
      : `lines ${current.anchor.from} to ${current.anchor.to}`

    const draftRow = document.createElement('tr')
    draftRow.className = 'draft-row'
    draftRow.innerHTML = `<td class="thread-cell" colspan="${columns}">`
      + `<form class="draft">`
      + `<label class="visually-hidden" for="draft-input">Comment on ${escapeText(lines)}</label>`
      + `<textarea id="draft-input" class="draft-input" rows="3"`
      + ` placeholder="Comment on ${escapeText(lines)}"></textarea>`
      + `<div class="draft-actions">`
      + `<button type="submit" class="btn btn-primary btn-small">Comment</button>`
      + `<button type="button" class="btn btn-small draft-cancel">Cancel</button>`
      + `<span class="draft-status muted" role="status"></span>`
      + `</div></form></td>`

    row.insertAdjacentElement('afterend', draftRow)

    const input = draftRow.querySelector<HTMLTextAreaElement>('.draft-input')!
    input.value = current.text
    input.addEventListener('input', () => {
      current.text = input.value
      rememberDraft()
    })

    draftRow.querySelector('.draft-cancel')?.addEventListener('click', () => closeDraft())
    draftRow.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      void submitDraft(draftRow)
    })
  }

  /** Post the draft, then reload the file so the new thread is in its rows. */
  async function submitDraft(row: HTMLElement): Promise<void> {
    const current = draft
    const status = row.querySelector<HTMLElement>('.draft-status')
    if (current == null || current.busy || commentUrl == null)
      return

    const body = current.text.trim()
    if (body.length === 0) {
      if (status)
        status.textContent = 'A comment needs something in it.'
      return
    }

    current.busy = true
    if (status)
      status.textContent = 'Posting…'

    try {
      const form = new URLSearchParams({
        path: current.anchor.path,
        line: String(current.anchor.to),
        side: current.anchor.side,
        body,
      })

      // Only for a real range. A single line with a start line equal to it is
      // accepted by the server, and storing it would make every comment look
      // like a range comment in every later reader of the row.
      if (current.anchor.from !== current.anchor.to)
        form.set('start_line', String(current.anchor.from))

      // `writeHeaders` rather than a bare content type, because the router
      // checks a CSRF token on every non-safe method and a `fetch` carries
      // neither the header nor the `_token` field a form would. Without it
      // this post is answered 403 before it reaches the action - and only for
      // a reader who is signed in, which is everyone who can actually comment.
      const response = await fetch(commentUrl, {
        method: 'POST',
        headers: writeHeaders(),
        body: form,
      })

      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(error?.error ?? 'The comment could not be posted.')
      }

      const path = current.anchor.path
      closeDraft()
      // The thread is rendered into the file's rows by the server, so the way
      // to show it is to ask for that file again rather than to build a copy of
      // the thread markup here and have two renderers of it.
      await reloadFile(path)
    }
    catch (error) {
      current.busy = false
      if (status)
        status.textContent = error instanceof Error ? error.message : 'The comment could not be posted.'
    }
  }

  /**
   * What a reader can do with the lines they have selected.
   *
   * A bar that appears beside the selection rather than a menu they have to go
   * and find. Three things, which are the three reasons anybody selects lines
   * in a diff: to talk about them, to send somebody the link, or to take the
   * code somewhere else.
   *
   * Built once and moved, rather than created and destroyed as the selection
   * changes: this is repositioned after every frame, and a surface that
   * rebuilt itself at sixty hertz would take the focus ring with it.
   */
  let surface: HTMLElement | null = null

  function selectionSurface(): HTMLElement {
    if (surface != null)
      return surface

    const element = document.createElement('div')
    element.className = 'selection-surface'
    element.innerHTML = `<button type="button" class="btn btn-small" data-surface="comment">Comment</button>`
      + `<button type="button" class="btn btn-small" data-surface="link">Copy link</button>`
      + `<button type="button" class="btn btn-small" data-surface="lines">Copy lines</button>`
      + (blameUrl ? `<button type="button" class="btn btn-small" data-surface="why">Why this line?</button>` : '')

    element.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-surface]')?.dataset.surface
      if (action == null || selection == null)
        return

      if (action === 'comment')
        openDraft(selection)
      else if (action === 'link')
        void copyText(new URL(formatLineAnchor(selection), window.location.href).href, element)
      else if (action === 'why')
        void explainLine(selection)
      else
        void copyText(selectedText(selection), element)
    })

    region.appendChild(element)
    surface = element
    return element
  }

  /**
   * Why this line is here: one blame, at the moment of curiosity.
   *
   * A context line's left-side number indexes the merge base, which is what
   * the endpoint blames. Right-side selections on added lines have no
   * "before" to blame; the endpoint answers 422 and the note says so.
   */
  async function explainLine(anchor: LineAnchor): Promise<void> {
    if (!blameUrl)
      return

    const host = region.querySelector<HTMLElement>(`.diff-file-host[data-path="${cssEscape(anchor.path)}"]`)
    const cell = host?.querySelector<HTMLElement>(`.gutter.num[data-line="${anchor.from}"][data-side="${anchor.side}"]`)
    const row = cell?.closest('tr')
    if (!host || !row)
      return

    // The old-side number: the left cell of this row. A pure addition has
    // none, and the endpoint's refusal becomes the honest note.
    const leftCell = row.querySelector<HTMLElement>('.gutter.num[data-side="left"]')
    const oldLine = Number(leftCell?.dataset.line ?? 0)

    const existing = row.nextElementSibling
    if (existing?.classList.contains('blame-row')) {
      existing.remove()
      return
    }

    const note = document.createElement('tr')
    note.className = 'blame-row'
    const cellCount = row.querySelectorAll('td').length
    const target = document.createElement('td')
    target.colSpan = cellCount
    target.className = 'blame-cell muted'
    target.textContent = 'Asking git…'
    note.append(target)
    row.insertAdjacentElement('afterend', note)

    try {
      const query = new URLSearchParams({ path: anchor.path, line: String(oldLine) })
      const answer = await fetch(`${blameUrl}&${query}`, { headers: { Accept: 'application/json' } })
      const body: any = await answer.json().catch(() => null)

      if (!answer.ok || !body?.sha) {
        target.textContent = oldLine > 0
          ? 'git could not say why this line is here.'
          : 'This line is new in this pull request.'
        return
      }

      target.textContent = ''

      const sha = document.createElement('span')
      sha.className = 'mono'
      sha.textContent = String(body.sha).slice(0, 10)
      target.append(sha, document.createTextNode(` ${body.summary} — ${body.author}`))

      if (body.pullRequest) {
        target.append(document.createTextNode(' · '))
        const link = document.createElement('a')
        const prPath = window.location.pathname.replace(/\/pull\/\d+.*$/, `/pull/${body.pullRequest.number}`)
        link.href = prPath
        link.textContent = `#${body.pullRequest.number} ${body.pullRequest.title}`
        target.append(link)
      }
    }
    catch {
      target.textContent = 'git could not say why this line is here.'
    }
  }

  /** The code of the selected lines, as text, from what is rendered. */
  function selectedText(anchor: LineAnchor): string {
    const host = region.querySelector<HTMLElement>(`.diff-file-host[data-path="${cssEscape(anchor.path)}"]`)
    if (host == null)
      return ''

    const lines: string[] = []
    for (let line = anchor.from; line <= anchor.to; line++) {
      const cell = host.querySelector<HTMLElement>(`.gutter.num[data-line="${line}"][data-side="${anchor.side}"]`)
      const code = cell?.closest('tr')?.querySelector<HTMLElement>('.code')
      if (code == null)
        continue

      // Without the marker: `+` and `-` belong to the diff, not to the code,
      // and pasting them into an editor is somebody's afternoon.
      const marker = code.querySelector('.marker')
      lines.push((code.textContent ?? '').slice(marker?.textContent?.length ?? 0))
    }

    return lines.join('\n')
  }

  async function copyText(text: string, element: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      element.dataset.copied = 'true'
      window.setTimeout(() => { delete element.dataset.copied }, 1200)
    }
    catch {
      // Clipboard access can be refused, and there is nothing useful to say
      // about it beyond not pretending it worked.
      element.dataset.copied = 'false'
      window.setTimeout(() => { delete element.dataset.copied }, 1200)
    }
  }

  /** Put the surface beside the selection, or take it away. */
  function paintSelectionSurface(): void {
    const anchor = selection
    // Hidden while a draft is open: the draft *is* the thing the surface would
    // have offered, and two of them on screen is one too many.
    if (anchor == null || draft != null) {
      surface?.remove()
      surface = null
      return
    }

    const host = region.querySelector<HTMLElement>(`.diff-file-host[data-path="${cssEscape(anchor.path)}"]`)
    const cell = host?.querySelector<HTMLElement>(
      `.gutter.num[data-line="${anchor.from}"][data-side="${anchor.side}"]`,
    )
    const row = cell?.closest('tr')

    if (host == null || row == null) {
      surface?.remove()
      surface = null
      return
    }

    const element = selectionSurface()
    const top = row.getBoundingClientRect().top - region.getBoundingClientRect().top
    element.style.transform = `translateY(${Math.round(top)}px)`
  }

  /** Fetch a file's rows again, discarding what was cached for it. */
  async function reloadFile(path: string): Promise<void> {
    // The caches below are keyed by the diff's number, like every other map on
    // this page, so the file is looked up rather than positioned.
    const file = viewer.files().find(entry => entry.path === path)
    if (file == null)
      return

    const index = file.index

    markup.delete(index)
    asked.delete(index)
    wanted.add(index)
    scheduleRowFetch()
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
        const file = files.find(entry => entry.path === target.path)

        // Not in the list yet. Later batches will call this again, so give up
        // on this attempt rather than waiting on a file that may not be coming.
        if (file == null)
          return

        const index = file.index

        if (file.collapsed) {
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
          // The file this was looking for is now mounted, which is exactly what
          // a restored draft was waiting for.
          paintDraft()
          return
        }

        // The rows are still on their way, or the line is inside a gap. Asking
        // for the gap is the only one of those this can act on.
        const control = expandControlCovering(host, target.side, target.from)
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
  function expandControlCovering(
    host: HTMLElement,
    side: 'left' | 'right',
    line: number,
  ): HTMLElement | null {
    const controls = [...host.querySelectorAll<HTMLElement>('.hunk-expand')]

    const found = gapCovering(controls.map(control => ({
      from: Number(control.dataset.expandFrom),
      to: Number(control.dataset.expandTo),
      offset: Number(control.dataset.expandOffset ?? 0),
    })), side, line)

    return found === -1 ? null : controls[found] ?? null
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

    const file = viewer.fileFor(index)
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

      // Taller by exactly the rows that arrived. Told rather than measured, so
      // the list is right on this frame instead of dropping to the estimate for
      // one frame and correcting on the next - which the reader sees as
      // everything below the hunk jumping twice.
      viewer.growBy(index, expanded.count * DEFAULT_HEIGHT_METRICS.lineHeight)
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
    // A split row and a unified row of the same content wrap differently, so
    // what was measured in one layout is not a measurement of the other.
    rowHeights.clear()
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
   * nobody has to learn ours: `j` and `k` for files, `n` and `p` for threads,
   * and `N` and `P` for the threads still unresolved.
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
      // The same two keys with shift, for the conversations still open. A
      // second round of review is mostly "what did I ask for that has not been
      // answered", and walking every thread to find them means reading every
      // one somebody already resolved.
      case 'N':
        event.preventDefault()
        goToThread(1, true)
        break
      case 'P':
        event.preventDefault()
        goToThread(-1, true)
        break
      case '/':
        // The key every list on the internet uses for its filter. Worth
        // matching rather than inventing, because nobody reads a shortcut
        // list before reviewing a pull request.
        event.preventDefault()
        fileList?.focusSearch()
        break
      case 'v':
        // The verdict. Opens the drawer the page rendered - a key can only
        // press a control that exists, which is why the drawer had to come
        // first.
        event.preventDefault()
        openVerdict()
        break
      default:
        break
    }
  })

  /** Open the verdict drawer and put the caret where the words go. */
  function openVerdict(state?: string): void {
    const drawer = document.querySelector<HTMLDetailsElement>('[data-verdict-drawer]')
    if (!drawer)
      return

    drawer.open = true

    if (state) {
      const radio = drawer.querySelector<HTMLInputElement>(`input[name="state"][value="${state}"]`)
      if (radio)
        radio.checked = true
    }

    drawer.querySelector<HTMLTextAreaElement>('.verdict-body')?.focus()
  }

  // Submitting without leaving the textarea. Scoped to the form on purpose:
  // this is the one listener that fires while the reader is typing, and it
  // must fire nowhere else.
  document.querySelector<HTMLFormElement>('[data-verdict-form]')?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      ;(event.currentTarget as HTMLFormElement).requestSubmit()
    }
  })

  /*
   * The command palette: everything above, findable by name. A static
   * registry rather than anything clever - each entry is a label and one of
   * the handlers that already exist, and the palette's whole job is matching
   * a few words to one of them.
   */
  interface PaletteCommand {
    label: string
    hint: string
    run: () => void
  }

  const conversationUrl = window.location.pathname.replace(/\/files\/?$/, '')

  const paletteCommands: PaletteCommand[] = [
    { label: 'Next file', hint: 'j', run: () => goToFile(currentFile() + 1) },
    { label: 'Previous file', hint: 'k', run: () => goToFile(currentFile() - 1) },
    { label: 'Next thread', hint: 'n', run: () => goToThread(1) },
    { label: 'Previous thread', hint: 'p', run: () => goToThread(-1) },
    { label: 'Next unresolved thread', hint: 'N', run: () => goToThread(1, true) },
    { label: 'Previous unresolved thread', hint: 'P', run: () => goToThread(-1, true) },
    { label: 'Find a file', hint: '/', run: () => fileList?.focusSearch() },
    { label: 'Approve', hint: 'v', run: () => openVerdict('approved') },
    { label: 'Request changes', hint: 'v', run: () => openVerdict('changes_requested') },
    { label: 'Comment', hint: 'v', run: () => openVerdict('commented') },
    { label: 'Go to conversation', hint: '', run: () => window.location.assign(conversationUrl) },
    { label: 'Go to commits', hint: '', run: () => window.location.assign(`${conversationUrl}?tab=commits`) },
    { label: 'Go to checks', hint: '', run: () => window.location.assign(`${conversationUrl}?tab=checks`) },
  ]

  let paletteOpen: HTMLElement | null = null

  function closePalette(): void {
    paletteOpen?.remove()
    paletteOpen = null
  }

  function openPalette(): void {
    if (paletteOpen)
      return

    const overlay = document.createElement('div')
    overlay.className = 'palette-overlay'

    const panel = document.createElement('div')
    panel.className = 'palette'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Commands')

    const input = document.createElement('input')
    input.className = 'palette-input'
    input.placeholder = 'Type a command'
    input.setAttribute('aria-label', 'Filter commands')

    const list = document.createElement('div')
    list.className = 'palette-list'
    list.setAttribute('role', 'listbox')

    panel.append(input, list)
    overlay.append(panel)

    let matches: PaletteCommand[] = paletteCommands
    let selected = 0

    const paint = (): void => {
      list.textContent = ''

      if (matches.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'muted palette-empty'
        empty.textContent = 'Nothing matches.'
        list.append(empty)
        return
      }

      matches.forEach((command, index) => {
        const item = document.createElement('div')
        item.className = 'palette-item'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', index === selected ? 'true' : 'false')

        const label = document.createElement('span')
        label.textContent = command.label

        const hint = document.createElement('span')
        hint.className = 'mono muted'
        hint.textContent = command.hint

        item.append(label, hint)
        item.addEventListener('click', () => {
          closePalette()
          command.run()
        })

        list.append(item)
      })

      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    }

    input.addEventListener('input', () => {
      const needle = input.value.trim().toLowerCase()
      matches = needle
        ? paletteCommands.filter(command => command.label.toLowerCase().includes(needle))
        : paletteCommands
      selected = 0
      paint()
    })

    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        selected = Math.min(selected + 1, matches.length - 1)
        paint()
      }
      else if (event.key === 'ArrowUp') {
        event.preventDefault()
        selected = Math.max(selected - 1, 0)
        paint()
      }
      else if (event.key === 'Enter') {
        event.preventDefault()
        const command = matches[selected]
        closePalette()
        command?.run()
      }
      else if (event.key === 'Escape') {
        event.preventDefault()
        closePalette()
      }
    })

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay)
        closePalette()
    })

    document.body.append(overlay)
    paletteOpen = overlay
    paint()
    input.focus()
  }

  // Cmd+K / Ctrl+K, the spelling every launcher has trained. Registered
  // separately from the main switch because it must also fire while typing -
  // reaching the palette from a reply box is the point of having one.
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      openPalette()
    }
  })

  /**
   * The file the reader is looking at: the first one at or below the top.
   *
   * Answered as a *position*, because its callers do arithmetic on it - the
   * next file, the previous file - and "one more than this file's number in the
   * diff" is not the next file in a list showing a subset. The translation back
   * to the diff's numbering happens in `goToFile`, at the edge.
   */
  function currentFile(): number {
    const positions = positionsByKey(viewer.files().map(file => file.index))
    const mounted = [...region.querySelectorAll<HTMLElement>('.diff-file-host')]
      .map(host => ({ at: positions.get(Number(host.dataset.fileIndex)), top: host.getBoundingClientRect().top }))
      .filter((entry): entry is { at: number, top: number } => entry.at != null)
      .sort((a, b) => a.at - b.at)

    const edge = view.getBoundingClientRect().top
    // A tolerance, because the file at the top is usually a pixel or two above
    // it rather than exactly on it.
    const visible = mounted.find(entry => entry.top >= edge - 4)

    return visible?.at ?? mounted[mounted.length - 1]?.at ?? 0
  }

  /** Takes a position in the list; speaks to the viewer in the diff's numbering. */
  function goToFile(position: number): void {
    const files = viewer.files()
    const clamped = Math.max(0, Math.min(position, files.length - 1))
    const file = files[clamped]
    if (file == null)
      return

    if (file.collapsed)
      viewer.setCollapsed(file.index, false)

    viewer.scrollToFile(file.index)
  }

  /**
   * The next conversation in either direction.
   *
   * Over what is mounted rather than over the whole diff, because a thread is
   * markup and only mounted files have any. Moving past the end of what is
   * mounted scrolls, which mounts more, so holding the key still walks the
   * whole review.
   */
  function goToThread(direction: 1 | -1, unresolvedOnly = false): void {
    // A resolved thread folds down to one line and is rendered with
    // `is-resolved` on it, so "the conversations still open" is a selector
    // rather than a second pass over the data.
    const selector = unresolvedOnly ? '.thread:not(.is-resolved)' : '.thread'
    const threads = [...region.querySelectorAll<HTMLElement>(selector)]
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
        store: reviewStore,
        onSelect: (index) => {
          const file = viewer.fileFor(index)
          if (file?.collapsed)
            viewer.setCollapsed(index, false)
          viewer.scrollToFile(index)
        },
        // Marking a file read folds it away, which is the point of marking it:
        // the next unread file moves up to where the reader is looking.
        onViewedChange: (path, isViewed) => {
          const file = viewer.files().find(entry => entry.path === path)
          if (file != null)
            viewer.setCollapsed(file.index, isViewed)
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
    const now = performance.now()

    if (!force && allFiles.length - treeAt < TREE_EVERY_FILES && now - treeTime < TREE_EVERY_MS)
      return

    treeAt = allFiles.length
    treeTime = now
    // Everything, not what the diff is currently showing: the sidebar does its
    // own narrowing, and "2 of 40" is a sentence it can only write if it knows
    // about the 40.
    fileList?.setFiles(allFiles)
  }

  /**
   * Fold away everything the reader has already finished with.
   *
   * Ticking a file folds it, and a tick that is remembered across visits but
   * does not fold on the way back only remembers half of what it was for: the
   * reader returns to two hundred open files with a column of ticks beside
   * them, and has to fold them again by hand.
   *
   * Folded, and only folded. Unfolding everything that is *not* ticked would
   * open the large files the viewer collapsed on purpose, so this only ever
   * closes.
   */
  function applyViewedFolds(): void {
    viewer.files().forEach((file, position) => {
      if (reviewStore.viewed.has(file.path))
        viewer.setCollapsed(position, true)
    })
  }

  /**
   * The server's answer landing on top of what this machine remembered.
   *
   * Asked for alongside the stream rather than before it, because the diff is
   * what the reader came for and a round trip for their progress must not delay
   * a single row of it. Usually it lands while files are still arriving, and
   * what has arrived is what gets folded; `onEnd` folds the rest.
   */
  reviewStore.subscribe((what) => {
    if (what === 'viewed') {
      applyViewedFolds()
      return
    }

    // A draft the reader has already started typing into is theirs and stays
    // put - `restoreDraft` returns immediately when one is open. Losing words
    // to a version of the same draft from another machine would be the exact
    // failure this feature exists to prevent, and their next keystroke sends
    // what is on screen back to the server anyway.
    restoreDraft()
  })

  void reviewStore.load()

  /**
   * "Since I last looked", offered only when there is something to offer.
   *
   * The control is not rendered until the server has said this reader has read
   * this pull request before *and* that something has moved since. A toggle
   * that is always there is a toggle that answers "nothing changed" on a first
   * visit, which reads as a broken feature rather than as an honest answer.
   *
   * Asked for after the manifest, not before: it costs two diffs on the server
   * and the reader has not finished looking at the first screen yet.
   */
  /**
   * The way into one file's interdiff, painted onto its header.
   *
   * Painted on every render pass rather than baked into the markup, because
   * hosts are recycled - the same reason selection and drafts repaint. Only
   * on files the since-last-look answer named: an interdiff of an unchanged
   * file is an empty page with extra steps.
   */
  function paintInterdiffOffers(): void {
    if (!sinceChanged || !interdiffUrl)
      return

    for (const host of region.querySelectorAll<HTMLElement>('.diff-file-host')) {
      const index = Number(host.dataset.fileIndex)
      const file = viewer.fileFor(index)
      if (!file || !sinceChanged.has(file.path))
        continue

      const head = host.querySelector<HTMLElement>('.diff-head')
      if (!head || head.querySelector('.diff-interdiff-btn'))
        continue

      const control = document.createElement('button')
      control.type = 'button'
      control.className = 'btn btn-small diff-interdiff-btn'
      control.textContent = 'What changed since you looked'
      head.append(control)
    }
  }

  /**
   * Fetch and show one file's interdiff, between its header and its rows.
   *
   * Inserted beside the file's own table, never inside it: the row numbering
   * the windows live on must not move. The height genuinely changed, so the
   * file is remeasured in place.
   */
  async function openInterdiff(index: number, control: HTMLElement): Promise<void> {
    const file = viewer.fileFor(index)
    if (!file || !interdiffUrl)
      return

    const host = region.querySelector<HTMLElement>(`.diff-file-host[data-file-index="${index}"]`)
    const head = host?.querySelector<HTMLElement>('.diff-head')
    if (!host || !head)
      return

    const existing = host.querySelector<HTMLElement>('.diff-interdiff')
    if (existing) {
      existing.remove()
      viewer.remeasure(index)
      return
    }

    control.textContent = 'Comparing…'

    try {
      const answer = await fetch(`${interdiffUrl}&path=${encodeURIComponent(file.path)}`, {
        headers: { Accept: 'application/json' },
      })
      if (!answer.ok)
        throw new Error(await answer.text())

      const body: any = await answer.json()

      const panel = document.createElement('div')
      panel.className = 'diff-interdiff'

      if (body?.unchanged) {
        const note = document.createElement('p')
        note.className = 'muted'
        note.textContent = 'The proposal for this file has not moved since you looked.'
        panel.append(note)
      }
      else {
        const intro = document.createElement('p')
        intro.className = 'muted'
        intro.textContent = 'Outer markers are this round’s change; the inner +/- ride from the patch itself.'
        panel.append(intro)
        panel.insertAdjacentHTML('beforeend', String(body?.html ?? ''))
      }

      head.insertAdjacentElement('afterend', panel)
      viewer.remeasure(index)
    }
    catch {
      // Nothing to offer is the same outcome as not being able to ask.
    }
    finally {
      control.textContent = 'What changed since you looked'
    }
  }

  /**
   * Mark the ticks that have stopped being true.
   *
   * Asked for once the list is known, like the offer below it, and for the same
   * reason: it costs the server a diff per round the reader ticked in and
   * nobody is waiting on it. A failure leaves every tick as it was, which is
   * the state the page was already showing.
   */
  async function markStaleTicks(): Promise<void> {
    const url = staleUrl
    if (!url || !fileList)
      return

    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok)
        return

      const answer = await response.json() as { stale?: string[], unverifiable?: string[] }

      fileList.setStale(new Set(answer.stale ?? []), new Set(answer.unverifiable ?? []))
    }
    catch {
      // Nothing to mark is the same outcome as not being able to ask.
    }
  }

  async function offerSinceLastLook(): Promise<void> {
    // Read here rather than captured, for the same reason `region` and `view`
    // are captured above: the guard at the top of `mountDiffFiles` does not
    // narrow inside a closure, and asserting reads as though these could be
    // null when they cannot.
    const url = sinceUrl
    if (!url || !fileList || !listHost)
      return

    let answer: {
      looked?: boolean
      unreadable?: boolean
      changed?: string[]
      added?: string[]
      removed?: string[]
    } | null = null

    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok)
        return

      answer = await response.json()
    }
    catch {
      // Nothing to offer is the same outcome as not being able to ask.
      return
    }

    if (!answer?.looked || answer.unreadable)
      return

    // `removed` is deliberately left out. Those paths are not in this diff any
    // more, so restricting to them would produce an empty list; they belong in
    // a sentence, not in a filter.
    const paths = [...(answer.changed ?? []), ...(answer.added ?? [])]
    if (paths.length === 0)
      return

    const changed = new Set(paths)
    sinceChanged = changed
    const control = document.createElement('button')
    control.type = 'button'
    control.className = 'file-list-since'
    control.setAttribute('aria-pressed', 'false')
    control.textContent = `${paths.length} changed since you looked`
    listHost.insertBefore(control, listHost.firstChild)

    control.addEventListener('click', () => {
      const on = control.getAttribute('aria-pressed') !== 'true'
      control.setAttribute('aria-pressed', on ? 'true' : 'false')

      restriction = on ? changed : null
      fileList.setRestriction(restriction)

      /*
       * And the diff itself, which is the point.
       *
       * Narrowing only the sidebar left the reader scrolling past forty
       * unchanged files to reach the three that moved - the list said "3 of 43"
       * while showing all 43. `setFiles` keeps what the two lists have in
       * common: the files that survive keep their element, their measured
       * height and their fetched rows, and the reader's place follows the file
       * they were in rather than the position it used to occupy. Nothing is
       * re-downloaded in either direction, because the caches are keyed by the
       * diff's number and every file kept its number.
       */
      viewer.setFiles(restriction == null ? allFiles : allFiles.filter(file => restriction!.has(file.path)))
    })
  }

  void streamDiffManifest(manifestUrl, {
    onFiles(files) {
      allFiles.push(...files)
      // A file arriving while the list is narrowed joins the list only if it
      // belongs to what the reader asked to see. It is in `allFiles` either
      // way, so turning the filter off shows it without another request.
      viewer.addFiles(restriction == null ? files : files.filter(file => restriction!.has(file.path)))
      refreshFileList()
      say(`${allFiles.length} files…`)
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
      // file near the end can be honoured - and the earliest a draft can be put
      // back on the line it was written against.
      refreshFileList(true)
      applyViewedFolds()
      restoreDraft()
      void revealSelection()
      void offerSinceLastLook()
      void markStaleTicks()
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

/**
 * Escape a value for use inside a double-quoted attribute selector.
 *
 * Only the quote and the backslash need it there - not the whole of
 * `CSS.escape`, which is for identifiers and would turn every slash in a path
 * into an escape sequence. A path can legally contain a quote, and a selector
 * built by concatenation around one silently selects nothing.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** Escape text for the placeholder, which is the only markup built here. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
