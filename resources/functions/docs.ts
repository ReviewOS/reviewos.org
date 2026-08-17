/**
 * Reading a page out of the built documentation site.
 *
 * The work is here rather than in the view because a `.stx` component imports
 * nothing on its own, and because this is the part worth testing: which URL
 * maps to which file, and which URLs are refused.
 */

import { existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import process from 'node:process'

/** Bunpress's output directory, matching `outDir` in `config/docs.ts`. */
const ROOT = resolve(process.cwd(), 'dist/docs/.bunpress')

export interface DocsPage {
  status: number
  html: string
  /** Set when the request should go to a different URL instead. */
  redirect: string | null
}

/**
 * The page at this path under `/docs`, or a not-found that says why.
 *
 * ## Resolution, in order
 *
 * bunpress writes `todo/index.html` for a directory and
 * `todo/00-bootstrap/index.html` for a page, so a URL maps to a file in three
 * tries: the path itself, then `<path>/index.html`, then `<path>.html`. The
 * third is what makes an extensionless link work whichever way bunpress
 * decided to write that particular page.
 *
 * Only HTML is resolved. Assets that bunpress emits alongside the pages are
 * static files under `public/`, and a view that could return arbitrary file
 * contents from a directory next to the repository storage is a different and
 * much worse thing than a view that returns documentation pages.
 */
export async function readDocsPage(requested: string): Promise<DocsPage> {
  if (!existsSync(ROOT)) {
    return {
      status: 404,
      redirect: null,
      html: notice('The documentation has not been built', 'Run <code>./buddy build:docs</code> and reload.'),
    }
  }

  const path = decodeURIComponent(String(requested)).replace(/^\/+|\/+$/g, '')

  /*
   * The one security decision in this file.
   *
   * `normalize` collapses `..`, and the result is then required to still be
   * inside ROOT. Testing the request for `..` instead would miss the encoded
   * forms, and this reads from a directory that sits beside the repository
   * storage and the env file.
   */
  const candidate = normalize(join(ROOT, path))

  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}/`))
    return { status: 404, redirect: null, html: notice('Not found', 'That documentation page does not exist.') }

  // `.md` is the form the roadmap files link to each other by. Canonical is
  // the extensionless URL; see the note in the view.
  if (path.endsWith('.md'))
    return { status: 200, redirect: `/docs/${path.slice(0, -3)}`, html: '' }

  for (const attempt of [candidate, join(candidate, 'index.html'), `${candidate}.html`]) {
    const file = Bun.file(attempt)

    // `exists()` is false for a directory, which is what makes the bare
    // candidate safe to try first: `/docs/todo` tests the directory, fails,
    // and falls through to its index.
    if (attempt.endsWith('.html') && await file.exists())
      return { status: 200, redirect: null, html: await file.text() }
  }

  // The site's own 404 page when it has one, so the chrome survives.
  const own = Bun.file(join(ROOT, '404.html'))

  if (await own.exists())
    return { status: 404, redirect: null, html: await own.text() }

  return { status: 404, redirect: null, html: notice('Not found', 'That documentation page does not exist.') }
}

/** A page for the two cases where the site itself cannot answer. */
function notice(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title></head><body style="font-family: system-ui; padding: 3rem; max-width: 40rem;">`
    + `<h1 style="font-size: 1.25rem;">${title}</h1><p>${body}</p>`
    + `<p><a href="/">Back to ReviewOS</a></p></body></html>`
}
