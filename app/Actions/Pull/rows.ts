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
import { inlineChangedRanges, worthComparing } from './inline'

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
 */
export async function highlightDiffFile(file: DiffFile): Promise<DiffTokenMap> {
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

  const [leftTokens, rightTokens] = await Promise.all([
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
  /**
   * Render the file closed.
   *
   * Through a class rather than the `hidden` attribute. `hidden` is a boolean
   * attribute, so the browser hides the element whenever it is present whatever
   * the value: `hidden="false"` once made every diff on the page invisible.
   */
  collapsed?: boolean
  /**
   * Markup for the review threads on a line, if any.
   *
   * A slot rather than a parameter, so this module knows nothing about threads
   * beyond where they go. Threads sit under the line they were written about,
   * in the flow, so scrolling never separates a comment from its code.
   */
  threadsAt?: (line: DiffLine) => string
}

/** Escape for text content and for a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

/** The `+`, `-` or space that opens a code cell. */
function marker(origin: DiffLine['origin']): string {
  if (origin === 'added')
    return '+'

  return origin === 'removed' ? '-' : ' '
}

function hunkHeadRow(hunk: DiffHunk, columns: number): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  const heading = hunk.heading ? ` <span class="muted">${escapeHtml(hunk.heading)}</span>` : ''

  return `<tr class="hunk-head"><td class="gutter" colspan="${columns}"></td><td class="hunk-label mono">${escapeHtml(range)}${heading}</td></tr>`
}

/**
 * Unified rows: one line per row, both line numbers in the gutters.
 *
 * Both numbers, always. A review comment anchors to a line, a side and a
 * commit, and a reader who cannot see the old number cannot tell which side an
 * outdated thread was written against.
 */
function renderUnified(file: DiffFile, options: RenderRowsOptions): string {
  const parts: string[] = []

  for (const hunk of file.hunks) {
    parts.push(hunkHeadRow(hunk, 2))

    for (const line of hunk.lines) {
      // The code cell's content is emitted with no surrounding whitespace: it
      // is `white-space: pre`, so any indentation here would be printed and
      // every line would start a dozen columns in.
      parts.push(
        `<tr class="line line-${line.origin}">`
        + `<td class="gutter num">${line.oldLine ?? ''}</td>`
        + `<td class="gutter num">${line.newLine ?? ''}</td>`
        + `<td class="code mono"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens, options.marks?.get(line))}</td>`
        + `</tr>`,
      )

      const threads = options.threadsAt?.(line)
      if (threads)
        parts.push(`<tr class="thread-row"><td class="gutter" colspan="2"></td><td class="thread-cell">${threads}</td></tr>`)
    }
  }

  return parts.join('')
}

/** One side of a split row: a number gutter and a code cell, or a filler pair. */
function splitCell(line: DiffLine | null, side: 'old' | 'new', options: RenderRowsOptions): string {
  if (!line)
    return `<td class="gutter num"></td><td class="code is-empty mono"></td>`

  const number = side === 'old' ? line.oldLine : line.newLine

  return `<td class="gutter num">${number ?? ''}</td>`
    + `<td class="code mono"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens, options.marks?.get(line))}</td>`
}

/**
 * Split rows: the two sides beside each other.
 *
 * A run of changed lines is laid out as `max(removed, added)` rows, with the
 * shorter side padded, which is why a file is a different height in the two
 * layouts and why `countRows` reports both.
 */
function renderSplit(file: DiffFile, options: RenderRowsOptions): string {
  const parts: string[] = []

  for (const hunk of file.hunks) {
    parts.push(hunkHeadRow(hunk, 3))

    let removed: DiffLine[] = []
    let added: DiffLine[] = []

    const flush = () => {
      const height = Math.max(removed.length, added.length)

      for (let index = 0; index < height; index++) {
        const left = removed[index] ?? null
        const right = added[index] ?? null
        const classes = `line${left ? ' has-removed' : ''}${right ? ' has-added' : ''}`

        parts.push(`<tr class="${classes}">${splitCell(left, 'old', options)}${splitCell(right, 'new', options)}</tr>`)

        // A thread belongs to one side. Rendered under the row that carries the
        // line it was written about, so a comment on a deletion does not appear
        // to be about the addition beside it.
        const threads = (left ? options.threadsAt?.(left) : '') || (right ? options.threadsAt?.(right) : '')
        if (threads)
          parts.push(`<tr class="thread-row"><td class="gutter" colspan="4"><div class="thread-cell">${threads}</div></td></tr>`)
      }

      removed = []
      added = []
    }

    for (const line of hunk.lines) {
      if (line.origin === 'context') {
        flush()
        parts.push(`<tr class="line">${splitCell(line, 'old', options)}${splitCell(line, 'new', options)}</tr>`)

        const threads = options.threadsAt?.(line)
        if (threads)
          parts.push(`<tr class="thread-row"><td class="gutter" colspan="4"><div class="thread-cell">${threads}</div></td></tr>`)
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

  return parts.join('')
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

  const resolved: RenderRowsOptions = options.inlineChanges === false
    ? options
    : { ...options, marks: inlineMarksFor(file) }

  return resolved.layout === 'split' ? renderSplit(file, resolved) : renderUnified(file, resolved)
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
  const collapsed = options.collapsed === true
  const columns = options.layout === 'split' ? 4 : 3
  const body = renderDiffRows(file, options)
  const contents = body === ''
    ? renderDiffNote(file)
    : `<table class="diff-table" data-columns="${columns}">`
      + `<caption class="visually-hidden">Changes to ${escapeHtml(file.path)}</caption>`
      + `<tbody>${body}</tbody></table>`

  const renamedFrom = file.previousPath && file.previousPath !== file.path
    ? `<span class="muted">${escapeHtml(file.previousPath)}</span> <span class="muted" aria-hidden="true">-&gt;</span> `
    : ''

  return `<section class="diff-file panel" id="file-${escapeHtml(file.path)}">`
    + `<header class="diff-head">`
    + `<button type="button" class="diff-toggle" aria-expanded="${collapsed ? 'false' : 'true'}"`
    + ` aria-controls="body-${escapeHtml(file.path)}">`
    + `<span class="i-hugeicons-arrow-down-01" aria-hidden="true"></span></button>`
    + `<span class="diff-path mono">${renamedFrom}${escapeHtml(file.path)}</span>`
    + `<span class="diff-status pill pill-${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>`
    + `<span class="diff-counts mono" aria-label="${file.additions} added, ${file.deletions} removed">`
    + `<span class="count-add">+${file.additions}</span><span class="count-del">-${file.deletions}</span>`
    + `</span></header>`
    + `<div id="body-${escapeHtml(file.path)}" class="diff-body${collapsed ? ' is-collapsed' : ''}">${contents}</div>`
    + `</section>`
}
