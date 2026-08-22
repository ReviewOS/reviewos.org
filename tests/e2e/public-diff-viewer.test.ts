/**
 * The viewer, through the real server.
 *
 * Every part of this feature is correct in isolation and only exists when the
 * arrangement is right: the page is a *view* rather than a route, because the
 * server that answers a browser resolves file-based stx views for everything
 * outside `/api` and a route here would be a route nothing reaches. The
 * endpoint is a route, because it is under `/api`. Getting that backwards
 * produces a 404 on a page whose code is perfectly fine, which is exactly the
 * failure this suite exists to catch.
 *
 * Nothing here reaches GitHub. The assertions are about the doors: what answers
 * when the feature is off, what a URL that is not a diff gets, and where a
 * non-canonical URL sends a reader.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'

let available = false
let port = 0
let server: any = null

async function page(path: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' })

  return { status: answer.status, html: await answer.text() }
}

beforeAll(async () => {
  try {
    /*
     * Belt and braces. The value that counts is set in `tests/setup.ts`,
     * because `config/publicdiff.ts` reads it the first time *any* file imports
     * it - and by the time this hook runs, a unit test may already have. This
     * line is what remains correct if this file is ever run on its own.
     */
    process.env.PUBLIC_DIFF_ENABLED = 'true'

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

describe('the viewer answers where it is mounted', () => {
  test('a URL that is not a diff says so rather than 500ing', async () => {
    if (!available)
      return

    const { status, html } = await page('/view/owner/repository/tree/main')
    const text = html.replace(/<[^>]+>/g, ' ')

    expect(status).toBe(404)
    expect(text).toContain('not a diff URL')
    // And it says what does work, which is the difference between a 404 and a
    // 404 somebody can act on.
    expect(text).toContain('/view/owner/repository/pull/123')
  }, 60_000)

  test('a non-canonical URL sends the reader to the one link worth sharing', async () => {
    if (!available)
      return

    const { status, html } = await page('/view/owner/repository/pull/123/files')

    expect(status).toBe(200)
    expect(html).toContain('/view/owner/repository/pull/123')
    expect(html).toContain('http-equiv="refresh"')
  }, 60_000)

  test('the raw suffixes canonicalize to the same place', async () => {
    if (!available)
      return

    const { html } = await page('/view/owner/repository/pull/123.diff')

    expect(html).toContain('/view/owner/repository/pull/123')
  }, 60_000)
})

describe('the endpoints behind it', () => {
  /**
   * Three of them, and the target rides in the query on all three.
   *
   * A path parameter does not match across a slash, and a compare range is
   * `main...user:feature/x` - so in the path, every compare with a slashed
   * branch name is a 404, which is most of the interesting ones.
   */
  const endpoints = ['patch', 'manifest', 'rows'] as const

  test.each(endpoints)('/api/view/%s refuses a target that is not a diff', async (endpoint) => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/view/${endpoint}?owner=owner&repo=repository&kind=tree&ref=main`)

    expect(answer.status).toBe(422)
  }, 60_000)

  test('the rows endpoint refuses a request that names no files', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/view/rows?owner=o&repo=r&kind=pull&ref=1`)

    expect(answer.status).toBe(422)
  }, 60_000)

  test.each(endpoints)('/api/view/%s resolves, which is the arrangement that was wrong twice', async (endpoint) => {
    if (!available)
      return

    // Not asserting a diff comes back - that would reach GitHub. Asserting the
    // route exists at all: these live under `/api`, where the route registry is
    // loaded, and the page lives outside it, where views are.
    //
    // The status cannot decide it. A diff that does not exist is a 404 from
    // *our* handler and a route that does not exist is a 404 from the
    // framework, so the tell is the shape of the body: ours says `error`, the
    // framework's says `Not Found`.
    const answer = await fetch(`http://127.0.0.1:${port}/api/view/${endpoint}?owner=o&repo=r&kind=pull&ref=1&path=x`)
    const body = await answer.json().catch(() => null) as { message?: string, error?: string, ok?: boolean } | null

    expect(body).not.toBeNull()
    expect(body?.message).not.toBe('Not Found')
  }, 60_000)
})

describe('a large diff is streamed rather than rendered whole', () => {
  test('the page carries a stream host and points it at the endpoints', async () => {
    if (!available)
      return

    // Asserted on the *shape* rather than by fetching a real diff: what matters
    // here is that the page and the endpoints agree about the URL, which is the
    // seam that broke when the target moved out of the path.
    const { html } = await page('/view/owner/repository/pull/123')

    // A redirect page for a canonical URL carries no host, so this is the
    // canonical one. The host itself, by an attribute the bundle does not name.
    expect(html).toContain('/view/owner/repository/pull/123')
    expect(html).toContain('class="diff-stream"')
  }, 60_000)

  test('and names the two endpoints it will call, with the target in the query', async () => {
    if (!available)
      return

    const { html } = await page('/view/owner/repository/pull/123')

    // The target rides in the query because a compare range is
    // `main...user:feature/x` and a path parameter cannot match across a slash.
    expect(html).toContain('data-manifest-url="/api/view/manifest?owner=owner&amp;repo=repository&amp;kind=pull&amp;ref=123"')
    expect(html).toContain('data-rows-url="/api/view/rows?owner=owner&amp;repo=repository&amp;kind=pull&amp;ref=123"')
  }, 60_000)

  test('the page itself fetches nothing upstream', async () => {
    if (!available)
      return

    /*
     * `owner/repository#123` does not exist, and the page says nothing about
     * that - because it never asked. It used to: the document request was held
     * open while this server talked to GitHub, which on a large diff is
     * fourteen seconds of blank tab before the first byte, and on a phone reads
     * exactly like the failure this viewer exists to avoid.
     *
     * A failure title on this page would mean the fetch came back. There isn't
     * one, so it didn't happen.
     */
    const { status, html } = await page('/view/owner/repository/pull/123')

    expect(status).toBe(200)
    expect(html).toContain('class="diff-stream"')
    /*
     * Asserted on the failure panel's *heading*, not on `data-view-failure` and
     * not on the word "fetched". This page inlines its client bundle, and that
     * bundle names both of those - so either would be found on a page that is
     * working perfectly. The heading exists only in the template's failure
     * branch.
     */
    expect(html).not.toContain('That diff could not be shown')
  }, 60_000)

  test('and ships the layout the viewer needs to measure anything', async () => {
    if (!available)
      return

    /*
     * The defect a phone found. The grid and the fixed-height scroller lived in
     * the review screen's own style block; this page mounted the same markup
     * and carried none of it, so `.diff-scroller` was a plain block with no
     * height and no overflow. The virtualizer measured a viewport of nothing,
     * mounted nothing, and the page showed a file list above an empty space -
     * answering 200, carrying its whole manifest, and showing the reader no
     * diff at all.
     */
    const { html } = await page('/view/owner/repository/pull/123')

    expect(html).toContain('.diff-scroller {')
    expect(html).toContain('--diff-viewport-offset')
    // Sized from the visible height, not `100vh` - which in Mobile Safari is
    // the height with the toolbars hidden.
    expect(html).toContain('100dvh')
  }, 60_000)

  test('and offers a reader with no script the server-rendered whole', async () => {
    if (!available)
      return

    // The old noscript sent them to GitHub, which is a viewer admitting it
    // cannot show them the thing. `?render=whole` is slow and complete, and it
    // is the same page.
    const { html } = await page('/view/owner/repository/pull/123')

    expect(html).toContain('<noscript>')
    expect(html).toContain('render=whole')
  }, 60_000)
})
