/**
 * The rows of a file, rendered once.
 *
 * The same rule the diff surface arrived at after rendering its rows in two
 * places and watching them drift: **one renderer, whoever is asking.** The
 * first screen is rendered by the server into the page and later windows arrive
 * from an endpoint, and if those two produce even slightly different markup the
 * seam is visible exactly where a reader is scrolling.
 *
 * `CodeView.stx` renders this rather than looping in the template, so there is
 * no second spelling of a row to keep in step.
 */

import type { HighlightedToken } from './highlight'
import { escapeHtml } from '../Pull/shell'

export interface BlobRowOptions {
  /** The 1-based number of the first line, so a later window numbers correctly. */
  from?: number
}

/**
 * One `<tr>` per line, numbered from `from`.
 *
 * The tokens of a line are written without whitespace between the spans, which
 * is not a formatting preference: whitespace between them is whitespace in the
 * code, and in a file being read for review that is the difference between what
 * is on disk and what is on screen.
 */
export function renderBlobRows(lines: readonly HighlightedToken[][], options: BlobRowOptions = {}): string {
  const from = Math.max(1, Math.floor(options.from ?? 1))

  return lines.map((tokens, index) => {
    const number = from + index
    const code = tokens
      .map(token => `<span class="t-${escapeHtml(token.type)}">${escapeHtml(token.content)}</span>`)
      .join('')

    return `<tr class="source-row" data-line="${number}">`
      + `<td class="mono source-num">${number}</td>`
      + `<td class="mono source-code">${code}</td>`
      + `</tr>`
  }).join('')
}

/**
 * A row standing in for the lines that are not here.
 *
 * Sized from the line height rather than left to collapse, so the scrollbar
 * means something on a file whose middle has not been fetched: a spacer of the
 * right height is the difference between a scrollbar that describes the file
 * and one that describes what happens to be loaded.
 */
export function renderBlobSpacer(rows: number, lineHeight: number): string {
  if (rows <= 0)
    return ''

  return `<tr class="row-spacer" aria-hidden="true" data-rows="${rows}">`
    + `<td colspan="2" style="height:${Math.round(rows * lineHeight)}px;padding:0"></td>`
    + `</tr>`
}
