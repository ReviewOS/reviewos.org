/**
 * A file's diff, as markup.
 *
 * The rows are built here rather than in a template because two paths need
 * exactly the same ones: the first screen, rendered on the server and sent as
 * part of the page, and every screen after it, streamed to the virtualized list
 * as the reader scrolls. Two renderers producing nearly the same markup is how
 * a diff ends up with one appearance above the fold and another below it, and
 * it is the kind of divergence nobody notices until it is everywhere.
 *
 * Highlighting is done per side. A removed line belongs to the old file and an
 * added line to the new one, so they are tokenized as two separate documents;
 * highlighting them as one interleaved stream is how a viewer ends up
 * colouring a deletion as though it were part of the code that replaced it.
 */

import type { DiffFile, DiffHunk, DiffLine } from './diff'
import type { CharRange } from './inline'
import { highlightLines } from '../Browse/highlight'
import { gapsIn, oldOffsetAt } from './expand'
import { inlineChangedRanges, worthComparing } from './inline'
import { formatLineAnchor } from './lineLink'
import { classifyFile } from './classify'
import { escapeHtml, renderDiffHeadContents, renderDiffHeader, renderDiffShell } from './shell'

export interface DiffToken {
  type: string
  content: string
}

/** Tokens for every line, keyed `-oldLine` for the left and `+newLine` for the right. */
export type DiffTokenMap = Record<string, DiffToken[]>

/** The key a line's tokens are stored under. */
export function tokenKey(line: Pick<DiffLine, 'origin' | 'oldLine' | 'newLine'>): string {
  return line.origin === 'removed' ? `-${line.oldLine}` : `+${line.newLine}`
}

/**
 * Highlight both sides of a file's diff.
 *
 * The lines of each side are handed over as one document so the tokenizer
 * carries its state between them, which is what keeps a multi-line string or
 * comment from restarting at every hunk. The gaps between hunks are still gaps,
 * so a construct opened in one of them is not known about; that is the
 * documented limit of highlighting a patch rather than a file.
 *
 * `highlight: false` renders every line as one plain token instead, which is
 * the benchmark harness's stubbed mode. Layout and paint work is the thing
 * being measured there, and a token span per word is a large, variable share of
 * both - so leaving highlighting on while measuring a CSS change means
 * measuring the tokenizer's opinion of the fixture as much as the change. It
 * takes the same path a file over the tokenize ceiling already takes, so the
 * markup differs in exactly one way: the spans have no classes.
 */
export async function highlightDiffFile(
  file: DiffFile,
  options: { highlight?: boolean } = {},
): Promise<DiffTokenMap> {
  const left: string[] = []
  const leftKeys: string[] = []
  const right: string[] = []
  const rightKeys: string[] = []

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.origin !== 'added') {
        left.push(line.content)
        leftKeys.push(`-${line.oldLine}`)
      }
      if (line.origin !== 'removed') {
        right.push(line.content)
        rightKeys.push(`+${line.newLine}`)
      }
    }
  }

  const plain = (lines: readonly string[]): DiffToken[][] =>
    lines.map(line => [{ type: 'text' as const, content: line }])

  const [leftTokens, rightTokens] = options.highlight === false
    ? [plain(left), plain(right)]
    : await Promise.all([
        highlightLines(left, file.previousPath ?? file.path),
        highlightLines(right, file.path),
      ])

  const map: DiffTokenMap = {}
  leftKeys.forEach((key, index) => { map[key] = leftTokens[index] ?? [] })
  rightKeys.forEach((key, index) => { map[key] = rightTokens[index] ?? [] })

  return map
}

export interface RenderRowsOptions {
  layout?: 'unified' | 'split'
  tokens?: DiffTokenMap
  /**
   * Mark what changed within a line, not just which lines changed.
   *
   * On by default. A line where one argument moved is almost all unchanged, and
   * colouring the whole of it makes the reader do the comparison themselves.
   */
  inlineChanges?: boolean
  /** Computed by `renderDiffRows`; not something a caller supplies. */
  marks?: Map<DiffLine, CharRange[]>
  /** Also set by `renderDiffRows`, so a gutter can name the file it links into. */
  path?: string
  /**
   * Render the file closed, and say who is going to open it.
   *
   * Two answers, because there are two pages and they have different machinery:
   *
   * - `fetch` renders the header alone. The streamed viewer asks for the rows
   *   when the reader opens it, so sending them would be sending markup for
   *   something nobody has looked at - which is the whole point of folding it.
   * - `fold` renders the rows inside a `<details>`, closed. For a page with no
   *   client script, where nothing is going to fetch anything and a header on
   *   its own is a file that can never be read.
   *
   * `true` means `fetch`, which is what it always meant.
   */
  collapsed?: boolean | 'fetch' | 'fold'
  /**
   * Markup for the review threads on a line, if any.
   *
   * A slot rather than a parameter, so this module knows nothing about threads
   * beyond where they go. Threads sit under the line they were written about,
   * in the flow, so scrolling never separates a comment from its code.
   */
  threadsAt?: (line: DiffLine) => string
  /**
   * Offer to show the lines between hunks.
   *
   * Off by default, because the control is only useful where something can act
   * on it. The server-rendered first screen and the streamed rows both turn it
   * on; a row rendered *as* expanded context does not.
   */
  expandable?: boolean
  /**
   * Offer to start a comment on a line.
   *
   * Off by default, for the same reason `expandable` is: the control only makes
   * sense where something is listening for it.
   */
  commentable?: boolean
  /**
   * Render only the rows in this half-open range.
   *
   * For a file too large to put in the document at once. The indices are the
   * ones `countRows` counts, and that is not a coincidence to be maintained by
   * hand: the client asks for a range by number, and if the renderer's numbering
   * drifted from the counter's by one, every window would be off by a line and
   * the file would appear to scroll past itself.
   *
   * A thread row belongs to the line above it and shares that line's index, so
   * a conversation is never separated from the code it is about by a window
   * boundary.
   */
  range?: { from: number, to: number }
}

/** The tokens for one line, falling back to its raw content. */
function tokensFor(line: DiffLine, tokens: DiffTokenMap | undefined): DiffToken[] {
  if (!tokens)
    return [{ type: 'text', content: line.content }]

  // An empty array is a blank line and is left alone. A missing entry means the
  // highlighter declined, and the raw content beats nothing.
  return tokens[tokenKey(line)] ?? [{ type: 'text', content: line.content }]
}

function renderTokens(line: DiffLine, tokens: DiffTokenMap | undefined, changed?: readonly CharRange[]): string {
  const parts = tokensFor(line, tokens)

  if (!changed || changed.length === 0) {
    return parts
      .map(token => `<span class="t-${escapeHtml(token.type)}">${escapeHtml(token.content)}</span>`)
      .join('')
  }

  // A syntax token and a changed range are two different carvings of the same
  // line, and neither can be dropped: the token carries the colour, the range
  // carries the emphasis. So each token is cut at the range boundaries that
  // fall inside it, and the pieces are marked individually.
  let offset = 0
  let html = ''

  for (const token of parts) {
    const start = offset
    const end = offset + token.content.length
    offset = end

    for (const piece of cut(token.content, start, changed)) {
      const inner = escapeHtml(piece.text)
      html += piece.changed
        ? `<span class="t-${escapeHtml(token.type)} w">${inner}</span>`
        : `<span class="t-${escapeHtml(token.type)}">${inner}</span>`
    }
  }

  return html
}

/**
 * Cut one token into changed and unchanged pieces.
 *
 * `start` is where the token sits in the line, since the ranges are measured
 * against the line rather than against the token.
 */
function cut(
  text: string,
  start: number,
  changed: readonly CharRange[],
): Array<{ text: string, changed: boolean }> {
  const pieces: Array<{ text: string, changed: boolean }> = []
  const end = start + text.length
  let cursor = start

  for (const range of changed) {
    if (range.end <= cursor)
      continue
    if (range.start >= end)
      break

    const from = Math.max(range.start, cursor)
    const to = Math.min(range.end, end)

    if (from > cursor)
      pieces.push({ text: text.slice(cursor - start, from - start), changed: false })

    pieces.push({ text: text.slice(from - start, to - start), changed: true })
    cursor = to
  }

  if (cursor < end)
    pieces.push({ text: text.slice(cursor - start), changed: false })

  return pieces
}

/**
 * Pair each removed line with the added line that replaced it.
 *
 * Positionally: the first removal against the first addition, and so on. git
 * does not say which line replaced which, and position is what a reader assumes
 * when they look at the two blocks side by side.
 *
 * A pair that turns out to share almost nothing is dropped rather than marked,
 * because a deletion and an unrelated addition that happen to be adjacent are
 * not an edit to one line.
 */
export function pairInlineChanges(
  removed: readonly DiffLine[],
  added: readonly DiffLine[],
): Map<DiffLine, CharRange[]> {
  const marks = new Map<DiffLine, CharRange[]>()
  const pairs = Math.min(removed.length, added.length)

  for (let index = 0; index < pairs; index++) {
    const before = removed[index]!
    const after = added[index]!
    const diff = inlineChangedRanges(before.content, after.content)

    if (!worthComparing(before.content, after.content, diff))
      continue

    if (diff.before.length > 0)
      marks.set(before, diff.before)
    if (diff.after.length > 0)
      marks.set(after, diff.after)
  }

  return marks
}

/**
 * A line-number gutter, which is also the handle for selecting the line.
 *
 * An anchor rather than a button, and it carries the fragment it points at, so
 * a reader can copy the link from the context menu without the page running any
 * JavaScript at all. Clicking it is intercepted for the range behaviour; middle
 * clicking and copying still do what a link does.
 */
function gutter(path: string, side: 'left' | 'right', line: number | null, commentable = false): string {
  if (line == null)
    return `<td class="gutter num"></td>`

  const fragment = formatLineAnchor({ path, side, from: line, to: line })

  // The affordance that starts a comment, shown on hover and on focus. Only
  // rendered where something can act on it: the streamed viewer wires it, and
  // a server-rendered page with no JavaScript would otherwise carry a control
  // that does nothing at all.
  const comment = commentable
    ? `<button type="button" class="line-comment" tabindex="-1"`
      + ` aria-label="Comment on line ${line}"><span aria-hidden="true">+</span></button>`
    : ''

  return `<td class="gutter num" data-line="${line}" data-side="${side}">`
    + comment
    + `<a class="line-anchor" href="${escapeHtml(fragment)}"`
    + ` aria-label="Line ${line}">${line}</a></td>`
}

/**
 * The note that a line ends the file without a newline.
 *
 * Rendered rather than dropped, because adding or removing a trailing newline
 * is a real change and an invisible one: without this the diff shows two lines
 * that read identically and says one replaced the other.
 */
function noNewlineNote(line: DiffLine): string {
  if (line.noNewline !== true)
    return ''

  return `<span class="no-newline" title="No newline at end of file"`
    + ` aria-label="No newline at end of file">\u29F5</span>`
}

/** The `+`, `-` or space that opens a code cell. */
function marker(origin: DiffLine['origin']): string {
  if (origin === 'added')
    return '+'

  return origin === 'removed' ? '-' : ' '
}

function hunkHeadRow(
  hunk: DiffHunk,
  layout: 'unified' | 'split',
  gap?: { from: number, to: number, size: number },
): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  const heading = hunk.heading ? ` <span class="muted">${escapeHtml(hunk.heading)}</span>` : ''
  const label = `<td class="hunk-label mono" colspan="${layout === 'split' ? 4 : 1}">`
    + expandControl(gap, oldOffsetAt(hunk))
    + `${escapeHtml(range)}${heading}</td>`

  // In split the header spans the whole width. Sat in the last column, as it
  // did, it reads as a heading for the right-hand side rather than for the hunk
  // both sides belong to.
  return layout === 'split'
    ? `<tr class="hunk-head">${label}</tr>`
    : `<tr class="hunk-head"><td class="gutter" colspan="2"></td>${label}</tr>`
}

/**
 * The control that asks for the lines a hunk left out.
 *
 * A button rather than a link, and it carries the range it would ask for, so
 * the page needs no map from control to gap. Absent when there is no gap, which
 * is why it takes the gap rather than checking for one.
 *
 * It says how much it is hiding, on its face. A row of anonymous ellipses
 * between two hunks tells a reviewer nothing about whether the thing they
 * cannot see is four lines of imports or four hundred lines of the function
 * they are reading, and that is exactly the judgement they are trying to make.
 */
function expandControl(gap: { from: number, to: number, size: number } | undefined, offset: number): string {
  if (!gap || gap.size <= 0)
    return ''

  const lines = gap.size === 1 ? '1 line' : `${gap.size.toLocaleString('en-US')} lines`

  return `<button type="button" class="hunk-expand" data-expand-from="${gap.from}"`
    + ` data-expand-to="${gap.to}" data-expand-offset="${offset}"`
    + ` title="Show the ${escapeHtml(lines)} above this">`
    + `<span aria-hidden="true">⋯</span>`
    + `<span class="hunk-skipped">${escapeHtml(lines)}</span>`
    + `<span class="visually-hidden">Show the ${escapeHtml(lines)} above this hunk</span>`
    + `</button>`
}

/**
 * Collect rows, keeping only the ones the caller asked for.
 *
 * The row index is maintained here rather than by each layout, because the
 * whole point is that one number means the same thing to the counter, to both
 * renderers and to the client. `next()` is called once per row whether or not
 * it is kept, so the numbering never depends on the range.
 */
function rowCollector(range: RenderRowsOptions['range']) {
  const parts: string[] = []
  let index = -1

  return {
    /** Start a row, and say whether it is one to keep. */
    next(): boolean {
      index += 1
      return range == null || (index >= range.from && index < range.to)
    },
    /** Add markup to the row `next` just started. */
    push(markup: string): void {
      parts.push(markup)
    },
    html: () => parts.join(''),
  }
}

/**
 * Unified rows: one line per row, both line numbers in the gutters.
 *
 * Both numbers, always. A review comment anchors to a line, a side and a
 * commit, and a reader who cannot see the old number cannot tell which side an
 * outdated thread was written against.
 */
function renderUnified(file: DiffFile, options: RenderRowsOptions): string {
  const rows = rowCollector(options.range)
  const gaps = options.expandable ? gapsByHunk(file) : undefined

  for (const [index, hunk] of file.hunks.entries()) {
    if (rows.next())
      rows.push(hunkHeadRow(hunk, 'unified', gaps?.get(index)))

    for (const line of hunk.lines) {
      if (!rows.next())
        continue

      // The code cell's content is emitted with no surrounding whitespace: it
      // is `white-space: pre`, so any indentation here would be printed and
      // every line would start a dozen columns in.
      rows.push(
        `<tr class="line line-${line.origin}">`
        + gutter(file.path, 'left', line.oldLine, options.commentable)
        + gutter(file.path, 'right', line.newLine, options.commentable)
        + `<td class="code mono"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens, options.marks?.get(line))}${noNewlineNote(line)}</td>`
        + `</tr>`,
      )

      const threads = options.threadsAt?.(line)
      if (threads)
        rows.push(`<tr class="thread-row"><td class="gutter" colspan="2"></td><td class="thread-cell">${threads}</td></tr>`)
    }
  }

  return rows.html()
}

/** One side of a split row: a number gutter and a code cell, or a filler pair. */
function splitCell(line: DiffLine | null, side: 'old' | 'new', options: RenderRowsOptions): string {
  // The side is on the cell so the two columns can be scrolled together. A
  // reader comparing two versions of a long line is reading across, and a
  // split view where only one side moves makes that impossible - which is the
  // one thing split view exists to make possible.
  if (!line)
    return `<td class="gutter num"></td><td class="code is-empty mono" data-side="${side}"></td>`

  const number = side === 'old' ? line.oldLine : line.newLine

  return gutter(options.path ?? '', side === 'old' ? 'left' : 'right', number, options.commentable)
    + `<td class="code mono" data-side="${side}"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens, options.marks?.get(line))}${noNewlineNote(line)}</td>`
}

/**
 * Split rows: the two sides beside each other.
 *
 * A run of changed lines is laid out as `max(removed, added)` rows, with the
 * shorter side padded, which is why a file is a different height in the two
 * layouts and why `countRows` reports both.
 */
function renderSplit(file: DiffFile, options: RenderRowsOptions): string {
  const rows = rowCollector(options.range)
  const gaps = options.expandable ? gapsByHunk(file) : undefined

  for (const [index, hunk] of file.hunks.entries()) {
    if (rows.next())
      rows.push(hunkHeadRow(hunk, 'split', gaps?.get(index)))

    let removed: DiffLine[] = []
    let added: DiffLine[] = []

    const flush = () => {
      const height = Math.max(removed.length, added.length)

      for (let index = 0; index < height; index++) {
        if (!rows.next())
          continue

        const left = removed[index] ?? null
        const right = added[index] ?? null
        const classes = `line${left ? ' has-removed' : ''}${right ? ' has-added' : ''}`

        rows.push(`<tr class="${classes}">${splitCell(left, 'old', options)}${splitCell(right, 'new', options)}</tr>`)

        // A thread belongs to one side. Rendered under the row that carries the
        // line it was written about, so a comment on a deletion does not appear
        // to be about the addition beside it.
        const threads = (left ? options.threadsAt?.(left) : '') || (right ? options.threadsAt?.(right) : '')
        if (threads)
          rows.push(`<tr class="thread-row"><td class="gutter" colspan="4"><div class="thread-cell">${threads}</div></td></tr>`)
      }

      removed = []
      added = []
    }

    for (const line of hunk.lines) {
      if (line.origin === 'context') {
        flush()

        if (rows.next()) {
          rows.push(`<tr class="line">${splitCell(line, 'old', options)}${splitCell(line, 'new', options)}</tr>`)

          const threads = options.threadsAt?.(line)
          if (threads)
            rows.push(`<tr class="thread-row"><td class="gutter" colspan="4"><div class="thread-cell">${threads}</div></td></tr>`)
        }
      }
      else if (line.origin === 'removed') {
        removed.push(line)
      }
      else {
        added.push(line)
      }
    }

    flush()
  }

  return rows.html()
}

/**
 * The rows for one file, in the requested layout.
 *
 * Rows only: no table, no header. The virtualized list wraps them, and so does
 * the server-rendered first screen, which is what keeps the two identical.
 */
export function renderDiffRows(file: DiffFile, options: RenderRowsOptions = {}): string {
  if (file.binary || file.hunks.length === 0)
    return ''

  const resolved: RenderRowsOptions = {
    ...options,
    path: file.path,
    marks: options.inlineChanges === false ? undefined : inlineMarksFor(file),
  }

  return resolved.layout === 'split' ? renderSplit(file, resolved) : renderUnified(file, resolved)
}

/** The gap sitting above each hunk, by hunk index. */
function gapsByHunk(file: DiffFile): Map<number, { from: number, to: number, size: number }> {
  return new Map(gapsIn(file).map(gap => [gap.hunkIndex, gap]))
}

/**
 * Every intra-line mark in a file, worked out once.
 *
 * Per change block: a maximal run of removals followed by a run of additions is
 * one edit to a reader, and the lines inside it pair up in order.
 */
function inlineMarksFor(file: DiffFile): Map<DiffLine, CharRange[]> {
  const marks = new Map<DiffLine, CharRange[]>()

  for (const hunk of file.hunks) {
    let removed: DiffLine[] = []
    let added: DiffLine[] = []

    const flush = () => {
      if (removed.length > 0 && added.length > 0) {
        for (const [line, ranges] of pairInlineChanges(removed, added))
          marks.set(line, ranges)
      }
      removed = []
      added = []
    }

    for (const line of hunk.lines) {
      if (line.origin === 'context')
        flush()
      else if (line.origin === 'removed')
        removed.push(line)
      else
        added.push(line)
    }

    flush()
  }

  return marks
}

/**
 * The note a file with nothing to show line by line renders instead.
 *
 * A binary file, a mode change and a rename with no content change each render
 * as themselves rather than as an empty panel, because "there is nothing here"
 * and "we declined to show it" are different things to a reviewer.
 */
export function renderDiffNote(file: DiffFile): string {
  if (file.binary)
    return `<p class="diff-note muted">Binary file. Nothing to show line by line.</p>`

  if (file.hunks.length > 0)
    return ''

  if (file.oldMode && file.newMode) {
    return `<p class="diff-note muted">Mode changed from ${escapeHtml(file.oldMode)} to ${escapeHtml(file.newMode)}. `
      + `The contents are unchanged.</p>`
  }

  if (file.status === 'renamed' && file.previousPath)
    return `<p class="diff-note muted">Renamed from ${escapeHtml(file.previousPath)}. The contents are unchanged.</p>`

  return `<p class="diff-note muted">No changes to show.</p>`
}

/**
 * A whole file: header, then rows or a note.
 *
 * The unit the virtualized list mounts, and the unit the first screen renders.
 */
export function renderDiffFile(file: DiffFile, options: RenderRowsOptions = {}): string {
  const collapsed = options.collapsed === true ? 'fetch' : options.collapsed

  // The same badge the manifest sends the browser, computed the same way, so
  // the two pages cannot disagree about whether a file needs reading.
  const headed = file.hunks.length > 0
    ? { ...file, mechanical: classifyFile(file).reason }
    : file

  if (collapsed === 'fetch')
    return renderDiffShell(headed, { collapsed: true })

  const columns = options.layout === 'split' ? 4 : 3
  const body = renderDiffRows(file, options)
  const contents = body === ''
    ? renderDiffNote(file)
    : `<table class="diff-table" data-columns="${columns}">`
      + `<caption class="visually-hidden">Changes to ${escapeHtml(file.path)}</caption>`
      + `<tbody>${body}</tbody></table>`

  // Folded, with everything in it. A `<details>` opens with no script at all,
  // which is the requirement: the page this is for runs none, and a fold that
  // cannot be undone is a file that cannot be read.
  if (collapsed === 'fold') {
    return `<details class="diff-file panel" id="file-${escapeHtml(file.path)}">`
      + `<summary class="diff-head">${renderDiffHeadContents(headed)}</summary>`
      + `<div id="body-${escapeHtml(file.path)}" class="diff-body">${contents}</div>`
      + `</details>`
  }

  return `<section class="diff-file panel" id="file-${escapeHtml(file.path)}">`
    + renderDiffHeader(headed)
    + `<div id="body-${escapeHtml(file.path)}" class="diff-body">${contents}</div>`
    + `</section>`
}
