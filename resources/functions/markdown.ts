/**
 * The markdown pipeline, exposed to views.
 *
 * One function, deliberately: an issue body, a pull request description, a
 * review comment and a README are all user text, and all of them have to be
 * rendered by the same code so that a hole can only ever exist in one place.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { renderMarkdown as renderMarkdownImpl } from '../../app/Actions/Markdown/render'

export const renderMarkdown = renderMarkdownImpl
