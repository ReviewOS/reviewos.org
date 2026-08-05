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
import { highlightLines } from '../Browse/highlight'

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

function renderTokens(line: DiffLine, tokens: DiffTokenMap | undefined): string {
  return tokensFor(line, tokens)
    .map(token => `<span class="t-${escapeHtml(token.type)}">${escapeHtml(token.content)}</span>`)
    .join('')
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
        + `<td class="code mono"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens)}</td>`
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
    return `<td class="gutter num"></td><td class="code mono is-empty"></td>`

  const number = side === 'old' ? line.oldLine : line.newLine

  return `<td class="gutter num">${number ?? ''}</td>`
    + `<td class="code mono"><span class="marker" aria-hidden="true">${marker(line.origin)}</span>${renderTokens(line, options.tokens)}</td>`
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

  return options.layout === 'split' ? renderSplit(file, options) : renderUnified(file, options)
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
    + `<button type="button" class="diff-toggle" aria-expanded="true" aria-controls="body-${escapeHtml(file.path)}">`
    + `<span class="i-hugeicons-arrow-down-01" aria-hidden="true"></span></button>`
    + `<span class="mono diff-path">${renamedFrom}${escapeHtml(file.path)}</span>`
    + `<span class="diff-status pill pill-${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>`
    + `<span class="diff-counts mono" aria-label="${file.additions} added, ${file.deletions} removed">`
    + `<span class="count-add">+${file.additions}</span><span class="count-del">-${file.deletions}</span>`
    + `</span></header>`
    + `<div id="body-${escapeHtml(file.path)}" class="diff-body">${contents}</div>`
    + `</section>`
}
