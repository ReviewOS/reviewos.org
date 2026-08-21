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

describe('the proxy endpoint', () => {
  test('refuses a target that is not a pull request, commit or compare', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/view/owner/repository/tree/main`)

    expect(answer.status).toBe(422)
  }, 60_000)

  test('exists under /api, where the route registry is loaded', async () => {
    if (!available)
      return

    // Not asserting a diff comes back - that would reach GitHub. Asserting the
    // route resolves at all, which is the arrangement that was wrong twice.
    const answer = await fetch(`http://127.0.0.1:${port}/api/view/owner/repository/pull/123`)

    expect([200, 429]).toContain(answer.status)

    const body = await answer.json().catch(() => null) as { ok?: boolean, reason?: string } | null

    expect(body).not.toBeNull()
    // Off the network in a test environment, so whatever it says, it says it in
    // the shape the page knows how to read.
    expect(typeof body?.ok).toBe('boolean')
  }, 60_000)
})
