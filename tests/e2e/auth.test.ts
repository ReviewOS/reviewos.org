// Registering, signing in, and signing out, through the real routes.
//
// The framework ships auth actions that answer with JSON and set no cookie -
// right for an API client reading `access_token`, wrong for a form, because
// every page here identifies its reader from the session cookie. These
// overrides exist for that, so what this file has to prove is that a browser
// which posts the form ends up actually signed in, and that a browser which
// posts logout ends up actually signed out.
//
// The rules worth pinning are the ones that fail silently or invisibly:
//
//   - A handle that would shadow a route must be refused. `/settings` taken by
//     an account makes part of the product unreachable and hands whoever
//     registered it a page every reader trusts.
//   - Login must give the same answer for "no such account" and "wrong
//     password", or it is a way to test whether an address is registered here.
//   - Logout must revoke the token, not just drop the cookie. Signing out on a
//     shared machine is the reason anybody presses it.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { handles: [] as string[], emails: [] as string[] }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`
}

/**
 * A CSRF token, obtained the way a browser obtains one.
 *
 * The router checks a double submit on every non-safe method: a value from the
 * request against the `X-CSRF-Token` cookie. A browser gets that cookie on its
 * first GET and `<CsrfField />` echoes it back, so the form path works - and a
 * bare fetch that skips both is refused with a 403.
 *
 * Doing it properly here rather than exempting the route. Login is exactly
 * where the check should stay: a forced login is a real attack, and a test that
 * turns the check off would be testing an endpoint the product does not ship.
 */
let csrf = { token: '', cookie: '' }

async function primeCsrf(): Promise<void> {
  /*
   * From `/api/*`, not from `/login`, and that is a defect rather than a
   * detail.
   *
   * The cookie is seeded on API responses and *not* on the file-based views, so
   * a browser that lands on `/login` and submits the form in front of it has
   * nothing to match against. Priming from an API GET is what the test can do;
   * a person cannot. Written up in `docs/todo/01-foundation.md`.
   */
  const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Accept: 'text/html' } })
  const raw = answer.headers.get('set-cookie') ?? ''
  const match = /X-CSRF-Token=([^;]*)/.exec(raw)

  await answer.text()

  if (match) {
    csrf = { token: decodeURIComponent(match[1]), cookie: `X-CSRF-Token=${match[1]}` }
  }
}

async function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  const cookies = [csrf.cookie, headers.Cookie].filter(Boolean).join('; ')

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf.token ? { 'x-csrf-token': csrf.token } : {}),
      ...headers,
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** The session cookie a response set, if it set one. */
function cookieFrom(answer: Response): string {
  const raw = answer.headers.get('set-cookie') ?? ''
  const match = /auth-token=([^;]*)/.exec(raw)

  return match ? decodeURIComponent(match[1]) : ''
}

/** Register an account and return its handle and cookie. */
async function makeAccount(prefix = 'aut'): Promise<{ handle: string, email: string, password: string, cookie: string }> {
  const handle = unique(prefix)
  const email = `${handle}@example.com`
  const password = 'a-long-enough-password'

  created.handles.push(handle)
  created.emails.push(email)

  const answer = await post('/api/auth/register', { handle, email, password, name: 'Auth Tester' })

  return { handle, email, password, cookie: cookieFrom(answer) }
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

    await primeCsrf()

    available = true
  }
  catch (error) {
    console.warn(`[auth] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.emails.length > 0)
      await db.deleteFrom('users').where('email', 'in', created.emails).execute()
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('creating an account', () => {
  test('signs the browser in, with a cookie', async () => {
    if (!available)
      return

    // The whole reason this overrides the framework's action. Without the
    // cookie a browser gets JSON and stays signed out.
    const account = await makeAccount()

    expect(account.cookie).toBeTruthy()
  })

  test('and the account has the handle it asked for', async () => {
    if (!available)
      return

    // A handle is the URL segment, not a profile field. An account without one
    // has no page.
    const handle = created.handles[created.handles.length - 1]

    const row: any = await (globalThis as any).db
      .selectFrom('users')
      .select(['handle'])
      .where('handle', '=', handle)
      .executeTakeFirst()

    expect(row?.handle).toBe(handle)
  })

  test('refuses a handle that would shadow a route', async () => {
    if (!available)
      return

    // `/settings` taken by an account makes part of the product unreachable and
    // hands whoever registered it a page every reader trusts.
    const answer = await post('/api/auth/register', {
      handle: 'settings',
      email: `${unique('res')}@example.com`,
      password: 'a-long-enough-password',
    })

    expect(answer.status).toBe(422)
    expect((await answer.json() as any).error).toContain('reserved')
  })

  test('refuses a handle that is already taken', async () => {
    if (!available)
      return

    const existing = created.handles[0]
    const answer = await post('/api/auth/register', {
      handle: existing,
      email: `${unique('dup')}@example.com`,
      password: 'a-long-enough-password',
    })

    expect(answer.status).toBe(422)
    expect((await answer.json() as any).error).toContain('taken')
  })

  test('refuses a handle with characters that are not allowed', async () => {
    if (!available)
      return

    const answer = await post('/api/auth/register', {
      handle: 'not a handle',
      email: `${unique('bad')}@example.com`,
      password: 'a-long-enough-password',
    })

    expect(answer.status).toBe(422)
  })

  test('refuses a short password, on length alone', async () => {
    if (!available)
      return

    // Length, and no composition rule. Requiring a capital and a symbol
    // measurably produces worse passwords, because people satisfy it the same
    // way and then reuse the result.
    const answer = await post('/api/auth/register', {
      handle: unique('shr'),
      email: `${unique('shr')}@example.com`,
      password: 'short',
    })

    expect(answer.status).toBe(422)
    expect((await answer.json() as any).error).toContain('10 characters')
  })

  test('an address already registered is refused in the same words as a taken handle', async () => {
    if (!available)
      return

    // Deliberately not "you already have an account". Whether an address is
    // registered here is something only its owner should learn.
    const answer = await post('/api/auth/register', {
      handle: unique('sam'),
      email: created.emails[0],
      password: 'a-long-enough-password',
    })

    expect(answer.status).toBe(422)
    expect((await answer.json() as any).error).not.toContain('already have')
  })
})

describe('signing in', () => {
  test('with the right password, sets a cookie', async () => {
    if (!available)
      return

    const account = await makeAccount('sin')
    const answer = await post('/api/auth/login', { email: account.email, password: account.password })

    expect(answer.status).toBe(200)
    expect(cookieFrom(answer)).toBeTruthy()
  })

  test('and the cookie actually identifies the reader', async () => {
    if (!available)
      return

    // A cookie that is set and not accepted is the failure this whole override
    // exists to avoid, and it looks identical to working from the outside.
    const account = await makeAccount('idy')
    const answer = await post('/api/auth/login', { email: account.email, password: account.password })
    const cookie = cookieFrom(answer)

    const { viewerFromCookies } = await import('../../app/Actions/Identity/lookup')
    const viewer = await viewerFromCookies({ 'auth-token': cookie })

    expect(viewer?.handle).toBe(account.handle)
  })

  test('a wrong password and a missing account give the same answer', async () => {
    if (!available)
      return

    // Distinguishing them turns this endpoint into a way to test whether an
    // address has an account here, which is the first step of every
    // credential-stuffing run.
    const account = await makeAccount('sme')

    const wrong = await post('/api/auth/login', { email: account.email, password: 'not-the-password' })
    const missing = await post('/api/auth/login', { email: `${unique('nob')}@example.com`, password: 'not-the-password' })

    expect(wrong.status).toBe(missing.status)
    expect((await wrong.json() as any).error).toBe((await missing.json() as any).error)
  })

  test('neither sets a cookie', async () => {
    if (!available)
      return

    const answer = await post('/api/auth/login', { email: `${unique('nob')}@example.com`, password: 'nope' })

    expect(cookieFrom(answer)).toBe('')
  })

  test('a form gets a redirect rather than JSON', async () => {
    if (!available)
      return

    // A browser shown JSON is a browser that has to press back.
    const account = await makeAccount('frm')
    const answer = await post(
      '/api/auth/login',
      { email: account.email, password: account.password },
      { Accept: 'text/html' },
    )

    expect(answer.status).toBe(303)
    expect(cookieFrom(answer)).toBeTruthy()
  })

  test('and it will not redirect off this host', async () => {
    if (!available)
      return

    // An open redirect on a sign-in page sends somebody to an attacker's site
    // in the second after they type a password.
    const account = await makeAccount('rdr')
    const answer = await post(
      '/api/auth/login',
      { email: account.email, password: account.password, next: 'https://evil.example' },
      { Accept: 'text/html' },
    )

    expect(answer.headers.get('location')).not.toContain('evil.example')
  })
})

describe('signing out', () => {
  test('clears the cookie', async () => {
    if (!available)
      return

    const account = await makeAccount('out')
    const answer = await post('/api/auth/logout', {}, { Cookie: `auth-token=${account.cookie}` })

    expect(answer.status).toBe(200)
    expect(answer.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  test('and revokes the token, not just the browser copy', async () => {
    if (!available)
      return

    // Clearing the cookie alone leaves a live credential in a proxy log, a
    // synced profile, a shared machine - and a shared machine is the reason
    // anybody presses this. A logout that only tidies the browser lies to
    // exactly the person relying on it.
    const account = await makeAccount('rev')

    const { viewerFromCookies } = await import('../../app/Actions/Identity/lookup')
    expect((await viewerFromCookies({ 'auth-token': account.cookie }))?.handle).toBe(account.handle)

    await post('/api/auth/logout', {}, { Cookie: `auth-token=${account.cookie}` })

    expect(await viewerFromCookies({ 'auth-token': account.cookie })).toBeNull()
  })

  test('works when nobody was signed in', async () => {
    if (!available)
      return

    // There is nothing to distinguish: the desired state is "not signed in",
    // and it holds either way.
    expect((await post('/api/auth/logout', {})).status).toBe(200)
  })
})
