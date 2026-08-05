/**
 * A conflicted file, as rows.
 *
 * The same grid as a diff, because a reviewer resolving a conflict is doing the
 * same thing they do all day: reading two versions of a line and deciding. What
 * changes is what the two sides *are* - here they are ours and theirs rather
 * than before and after - and that the reader is being asked for an answer
 * rather than an opinion.
 *
 * Separate from `rows.ts` on purpose. That module renders a patch, which has
 * one shape; this renders a working tree file that has been marked up by a
 * failed merge, which has another. Sharing the row markup would mean one
 * function that renders two grammars and knows which by a flag.
 */

import type { ConflictRegion, FileRegion } from './conflicts'
import { escapeHtml } from './shell'

export interface ConflictRenderOptions {
  /**
   * Offer the three answers on each region.
   *
   * Off by default, for the same reason the diff's controls are: a page with no
   * script to act on them should not render buttons that do nothing.
   */
  resolvable?: boolean
}

/**
 * One side of a conflict: its label, then its lines.
 *
 * The label is what git wrote beside the marker - a branch name, `HEAD`, a
 * commit - and it is the only thing that tells a reader which of these two is
 * the change they are reviewing.
 */
function sideRows(
  side: { label: string, lines: string[] },
  kind: 'ours' | 'base' | 'theirs',
  heading: string,
): string {
  const label = side.label ? ` <span class="mono">${escapeHtml(side.label)}</span>` : ''

  const rows = side.lines.map(line =>
    `<tr class="line conflict-${kind}"><td class="gutter num"></td>`
    + `<td class="code mono">${escapeHtml(line)}</td></tr>`).join('')

  return `<tr class="conflict-head conflict-head-${kind}">`
    + `<td class="hunk-label" colspan="2">${escapeHtml(heading)}${label}</td></tr>`
    + rows
}

/** The three answers, as buttons that say what they will do. */
function resolveControls(index: number): string {
  const button = (choice: string, label: string) =>
    `<button type="button" class="btn btn-small conflict-accept"`
    + ` data-conflict="${index}" data-choice="${choice}">${escapeHtml(label)}</button>`

  return `<tr class="conflict-actions"><td colspan="2">`
    + button('ours', 'Keep ours')
    + button('theirs', 'Keep theirs')
    + button('both', 'Keep both')
    + `</td></tr>`
}

function conflictRows(region: ConflictRegion, index: number, options: ConflictRenderOptions): string {
  return sideRows(region.ours, 'ours', 'Ours')
    + (region.base == null ? '' : sideRows(region.base, 'base', 'Common ancestor'))
    + sideRows(region.theirs, 'theirs', 'Theirs')
    + (options.resolvable ? resolveControls(index) : '')
}

/**
 * Ordinary lines, numbered as they are in the file.
 *
 * Numbered from the region's own start rather than counted from the top, so a
 * region after a conflict is still numbered correctly even though the conflict
 * above it has more lines in the file than it will have once resolved.
 */
function textRows(lines: readonly string[], startLine: number): string {
  return lines.map((line, offset) =>
    `<tr class="line"><td class="gutter num">${startLine + offset}</td>`
    + `<td class="code mono">${escapeHtml(line)}</td></tr>`).join('')
}

/** Every region of a conflicted file, in order. */
export function renderConflictRows(regions: readonly FileRegion[], options: ConflictRenderOptions = {}): string {
  let conflictIndex = -1

  return regions.map((region) => {
    if (region.type === 'text')
      return textRows(region.lines, region.startLine)

    conflictIndex += 1
    return conflictRows(region, conflictIndex, options)
  }).join('')
}

/** A conflicted file, header and all, ready to mount. */
export function renderConflictFile(
  path: string,
  regions: readonly FileRegion[],
  options: ConflictRenderOptions = {},
): string {
  const conflicts = regions.filter(region => region.type === 'conflict').length
  const summary = conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`

  return `<section class="diff-file panel" id="file-${escapeHtml(path)}">`
    + `<header class="diff-head">`
    + `<span class="diff-path mono">${escapeHtml(path)}</span>`
    + `<span class="diff-status pill pill-pending">${escapeHtml(summary)}</span>`
    + `</header>`
    + `<div class="diff-body">`
    + `<table class="diff-table" data-columns="2">`
    + `<caption class="visually-hidden">Conflicts in ${escapeHtml(path)}</caption>`
    + `<tbody>${renderConflictRows(regions, options)}</tbody></table>`
    + `</div></section>`
}
