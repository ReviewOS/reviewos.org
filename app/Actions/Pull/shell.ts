/**
 * The parts of a file's markup that the browser also has to be able to render.
 *
 * Deliberately its own module, with no imports at all. `rows.ts` reaches the
 * highlighter, and the highlighter is forty eight grammars that the browser is
 * never going to download - phase 2 settled that, and the marketing site sells
 * it. Importing the header out of `rows.ts` would put the whole of that on the
 * wrong side of the wire, and it would do it silently, because a bundler that
 * fails to tree-shake one module produces a working page and a bundle four
 * hundred kilobytes larger.
 *
 * So: everything in here is string building over plain data, and the header of
 * a file has exactly one implementation whichever machine renders it.
 */

/** Escape for text content and for a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Everything about a file that its header shows.
 *
 * Narrower than a `DiffFile` on purpose: the browser has exactly this much
 * about every file in the diff, from the manifest, and nothing else. Stating
 * the requirement as a type is what lets one function render the header on
 * both sides instead of two functions drifting apart.
 */
export interface DiffHeaderFile {
  path: string
  previousPath?: string | null
  status: string
  additions: number
  deletions: number
}

/**
 * A file's header: the fold control, the path, the status and the counts.
 *
 * Shared, because the server renders it for a file it has parsed and the
 * browser renders it for a file it has only ever seen a manifest record for -
 * one that is collapsed, or whose rows have not arrived. Two spellings of this
 * header is how a diff comes to look like two different products depending on
 * whether a file happened to be open.
 */
export function renderDiffHeader(file: DiffHeaderFile, options: { collapsed?: boolean } = {}): string {
  return `<header class="diff-head">`
    + `<button type="button" class="diff-toggle" aria-expanded="${options.collapsed ? 'false' : 'true'}"`
    + ` aria-controls="body-${escapeHtml(file.path)}">`
    + `<span class="i-hugeicons-arrow-down-01" aria-hidden="true"></span></button>`
    + renderDiffHeadContents(file)
    + `</header>`
}

/**
 * Everything in a header except the control that folds it.
 *
 * Split out because a `<details>` needs the same path, status and counts inside
 * a `<summary>`, where the fold control is the summary itself and a button
 * inside it would be a second control for the same thing.
 */
export function renderDiffHeadContents(file: DiffHeaderFile): string {
  const renamedFrom = file.previousPath && file.previousPath !== file.path
    ? `<span class="muted">${escapeHtml(file.previousPath)}</span> <span class="muted" aria-hidden="true">-&gt;</span> `
    : ''

  return `<span class="diff-path mono">${renamedFrom}${escapeHtml(file.path)}</span>`
    + `<span class="diff-status pill pill-${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>`
    + `<span class="diff-counts mono" aria-label="${file.additions} added, ${file.deletions} removed">`
    + `<span class="count-add">+${file.additions}</span><span class="count-del">-${file.deletions}</span>`
    + `</span>`
}

/**
 * A file that is listed but not shown: collapsed, or still on its way.
 *
 * The whole point of a collapsed file is that its contents are not on the
 * page. Rendering the rows and hiding them with CSS costs the same parse, the
 * same memory and the same place in the inline row budget as showing them, and
 * a lock file is collapsed precisely because that cost is not worth paying.
 * The rows are fetched if the reader opens it, which is when they become worth
 * having.
 */
export function renderDiffShell(
  file: DiffHeaderFile,
  options: { collapsed?: boolean, pending?: boolean } = {},
): string {
  const classes = `diff-file panel${options.pending ? ' is-pending' : ''}`

  return `<section class="${classes}" id="file-${escapeHtml(file.path)}">`
    + renderDiffHeader(file, { collapsed: options.collapsed })
    + `<div id="body-${escapeHtml(file.path)}" class="diff-body is-collapsed"></div>`
    + `</section>`
}
