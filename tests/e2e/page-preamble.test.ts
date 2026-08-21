/**
 * Every page starts with a doctype, and not with its own source code.
 *
 * A literal `<head>` written inside a *comment* in a layout's server script is
 * read by stx's layout pipeline as the real one. It cuts there, and everything
 * from that point in the file - the rest of the comment, the imports, the
 * server code - is emitted as page text above the document. Every page in the
 * product was rendering a paragraph of prose about link previews above the top
 * bar, and it had been doing it long enough that nobody saw it any more.
 *
 * It was found by taking a screenshot of a page while measuring something else,
 * which is the only way it could have been found: it is legal HTML, the page
 * below it works perfectly, and no test asserted anything about what comes
 * *before* the document.
 *
 * So this asserts the thing nobody thought to: the first non-whitespace a
 * reader's browser receives is a doctype or stx's own layout marker, on every
 * kind of page this product serves.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let available = false
let port = 0
let server: any = null

/** What a page is allowed to begin with, before the document. */
const ALLOWED = /^\s*(?:<!--\s*stx-layout:[^>]*-->\s*)?<!DOCTYPE html>/i

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    available = port > 0
  }
  catch {
    available = false
  }
}, 60_000)

afterAll(() => {
  server?.stop?.(true)
})

describe('what a browser receives before the document', () => {
  const pages = [
    ['the marketing home page', '/'],
    ['a signed-out product page', '/login'],
    ['a listing page', '/explore'],
    ['a page that does not exist', '/nobody-has-this-handle'],
  ] as const

  test.each(pages)('%s begins with a doctype', async (_name, path) => {
    if (!available)
      return

    const html = await (await fetch(`http://127.0.0.1:${port}${path}`)).text()

    // Reported with what was actually found, because "does not match" on a
    // hundred kilobytes of HTML sends somebody to read all of it.
    expect(ALLOWED.test(html) ? 'a doctype' : JSON.stringify(html.slice(0, 200))).toBe('a doctype')
  }, 60_000)

  test.each(pages)('%s carries no server-script source', async (_name, path) => {
    if (!available)
      return

    const html = await (await fetch(`http://127.0.0.1:${port}${path}`)).text()
    const preamble = html.slice(0, html.search(/<!DOCTYPE html>/i) + 1)

    // The shapes a leaked server script has. An import statement or a `const`
    // before the doctype is source code being read as prose.
    expect(preamble).not.toContain('import {')
    expect(preamble).not.toContain('const ')
  }, 60_000)
})
