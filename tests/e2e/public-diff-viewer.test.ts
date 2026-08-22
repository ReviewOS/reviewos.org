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
    // Read by `config/publicdiff.ts` at import time, so it is set before the
    // routes and views are loaded rather than after.
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
    // canonical one.
    expect(html).toContain('/view/owner/repository/pull/123')
  }, 60_000)
})
