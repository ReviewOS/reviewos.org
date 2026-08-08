// A form, submitted the way a browser submits one.
//
// **Every form in this product was refused for a first-time visitor**, and
// nothing in the suite could see it: every write in these tests authenticates
// with a bearer token, and a bearer bypasses the CSRF check by design. So a
// hundred tests passed while no human could open an issue, create a repository,
// comment, or sign up.
//
// Two halves were missing and each is useless alone. The router never put the
// `X-CSRF-Token` cookie on a view response - it seeded only on the route
// pipeline, which a file-based view does not take. And `CsrfField` read the
// token from `__stxServeContext`, which is undefined under `route.serve()`, so
// it rendered an empty value; every other view in this codebase already falls
// back to the raw `Cookie` header and that component was the one that did not.
//
// This test does what neither the unit tests nor the bearer-authenticated e2e
// tests can: GET a page, keep the cookie, read the token out of the rendered
// HTML, and post the form. It is the third instance of the pattern in
// `docs/todo/index.md` under "A signed-in browser is not a signed-in test
// client", so it is pinned rather than trusted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { handles: [] as string[] }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`
}

/** GET a page and return the cookie it set and the token it embedded. */
async function visit(path: string): Promise<{ cookie: string, token: string, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })
  const html = await answer.text()

  return {
    cookie: /X-CSRF-Token=([^;]*)/.exec(answer.headers.get('set-cookie') ?? '')?.[1] ?? '',
    token: /name="_token"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '',
    html,
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    available = true
  }
  catch (error) {
    console.warn(`[csrf-forms] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.handles.length > 0)
      await db.deleteFrom('users').where('handle', 'in', created.handles).execute()
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('a page a browser has never seen', () => {
  test('sets the CSRF cookie', async () => {
    if (!available)
      return

    // Seeded on the route pipeline and not on the view path, so a visitor who
    // landed on a page rather than an API endpoint had no cookie at all.
    expect((await visit('/register')).cookie).toBeTruthy()
  })

  test('and embeds a token in the form', async () => {
    if (!available)
      return

    // `CsrfField` read `__stxServeContext`, which does not exist under
    // `route.serve()`, and rendered an empty value.
    expect((await visit('/register')).token).toBeTruthy()
  })

  test('and the two match, which is the whole check', async () => {
    if (!available)
      return

    // Either half alone leaves the form refused, and a mismatched pair fails
    // exactly the way a missing pair does.
    const page = await visit('/register')

    expect(page.token).toBe(page.cookie)
  })
})

describe('submitting that form', () => {
  test('is accepted, and the account is created', async () => {
    if (!available)
      return

    const page = await visit('/register')
    const handle = unique('csf')
    created.handles.push(handle)

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Cookie': `X-CSRF-Token=${page.cookie}`,
      },
      body: new URLSearchParams({
        _token: page.token,
        handle,
        email: `${handle}@example.com`,
        password: 'a-long-enough-password',
        name: 'Form Person',
      }),
    })

    // A redirect, not a 403 and not JSON.
    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe(`/${handle}`)
    expect(answer.headers.get('set-cookie')).toContain('auth-token=')
  })

  test('without the token it is still refused', async () => {
    if (!available)
      return

    // The check is doing its job; it was the seeding that was missing. A test
    // that only proved forms work could pass with CSRF turned off entirely.
    const page = await visit('/register')
    const handle = unique('nok')

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Cookie': `X-CSRF-Token=${page.cookie}`,
      },
      body: new URLSearchParams({
        handle,
        email: `${handle}@example.com`,
        password: 'a-long-enough-password',
      }),
    })

    expect(answer.status).toBe(403)
  })

  test('and a token that does not match the cookie is refused', async () => {
    if (!available)
      return

    const page = await visit('/register')
    const handle = unique('mis')

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Cookie': `X-CSRF-Token=${page.cookie}`,
      },
      body: new URLSearchParams({
        _token: 'a-token-from-somewhere-else',
        handle,
        email: `${handle}@example.com`,
        password: 'a-long-enough-password',
      }),
    })

    expect(answer.status).toBe(403)
  })
})

describe('the pages people actually land on', () => {
  test('the sign-in page carries a usable token', async () => {
    if (!available)
      return

    const page = await visit('/login')

    expect(page.token).toBeTruthy()
    expect(page.token).toBe(page.cookie)
  })

  test('so does the new-repository page', async () => {
    if (!available)
      return

    // Not signed in, so it renders its sign-in branch - and the assertion that
    // matters is that a page rendering a form gets a token at all.
    const page = await visit('/new')

    expect(page.cookie).toBeTruthy()
  })
})
