// The browsers signed in as you, and the button that ends one.
//
// The question this feature answers is "is anybody else signed in as me", and
// it is asked by somebody who has just sold a laptop, left a job, or seen a
// notification they did not expect. So the properties worth pinning are the
// ones that decide whether the answer can be acted on:
//
//   - two sign-ins produce two rows, and the row you are reading is marked;
//   - revoking one ends *that* browser and leaves the others alone;
//   - "sign out everywhere else" keeps the browser pressing it;
//   - it is your own sessions, always, with no parameter that could say
//     otherwise.
//
// Every session here is created by signing in, not by inserting a row. The
// device columns are written by the sign-in path, and a fixture that wrote them
// itself would pass while the real path recorded nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  handle: '',
  password: 'a-long-enough-password',
  userId: 0,
  csrf: { token: '', cookie: '' },
  laptop: '',
  phone: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const AGENTS = {
  laptop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
}

/** Sign in, and return the session cookie the browser would keep. */
async function signIn(agent: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': agent,
      'x-csrf-token': created.csrf.token,
      'Cookie': created.csrf.cookie,
      // Read as the client address, so the list has something beside the agent.
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    },
    body: JSON.stringify({ email: `${created.handle}@example.com`, password: created.password }),
  })

  await answer.text()

  const { sessionCookieName } = await import('../../app/Actions/Auth/session')
  const name = await sessionCookieName()
  const match = new RegExp(`${name}=([^;]*)`).exec(answer.headers.get('set-cookie') ?? '')

  if (!match)
    throw new Error(`signing in answered ${answer.status} and set no session cookie`)

  return `${name}=${match[1]}`
}

/** Call the sessions endpoint as one of those browsers. */
async function sessions(cookie: string, body: Record<string, unknown> = {}): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/user/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': `${cookie}; ${created.csrf.cookie}`,
      'x-csrf-token': created.csrf.token,
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Whether a cookie still gets past `auth`. */
async function stillSignedIn(cookie: string): Promise<boolean> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/user`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  })

  await answer.text()

  return answer.status === 200
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const seed = await fetch(`http://127.0.0.1:${port}/api/health?quick=1`)
    const match = /X-CSRF-Token=([^;]*)/.exec(seed.headers.get('set-cookie') ?? '')
    await seed.text()

    if (!match)
      throw new Error('no CSRF cookie was seeded')

    created.csrf = { token: decodeURIComponent(match[1]!), cookie: `X-CSRF-Token=${match[1]}` }
    created.handle = unique('sess')

    const registered = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-csrf-token': created.csrf.token,
        'Cookie': created.csrf.cookie,
      },
      body: JSON.stringify({
        handle: created.handle,
        email: `${created.handle}@example.com`,
        password: created.password,
        name: 'Session Person',
      }),
    })

    await registered.text()

    if (registered.status >= 400)
      throw new Error(`registration answered ${registered.status}`)

    const row: any = await db
      .selectFrom('users')
      .select(['id'])
      .where('handle', '=', created.handle)
      .executeTakeFirst()

    created.userId = Number(row?.id)

    // Two browsers, signed in one after the other, exactly as two devices
    // would be.
    created.laptop = await signIn(AGENTS.laptop)
    created.phone = await signIn(AGENTS.phone)

    available = true
  }
  catch (error) {
    console.warn(`[sessions] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('audit_events').where('actor_id', '=', created.userId).execute()
      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('the list', () => {
  test('shows both browsers, described so a person can tell them apart', async () => {
    if (!available)
      return

    const answer = await sessions(created.laptop, { operation: 'list' })

    expect(answer.status).toBe(200)

    const devices = (answer.body?.sessions ?? []).map((one: any) => one.device)

    // The whole point of recording the agent. Without these two strings the
    // page is a column of identical timestamps.
    expect(devices).toContain('Chrome on macOS')
    expect(devices).toContain('Safari on iPhone')
  }, 30_000)

  test('marks the browser doing the reading', async () => {
    if (!available)
      return

    /*
     * "Revoke" is a frightening button to press when you cannot tell whether
     * you are about to sign yourself out, and somebody who presses it once by
     * mistake never presses it again.
     */
    const asLaptop = await sessions(created.laptop, { operation: 'list' })
    const current = (asLaptop.body?.sessions ?? []).filter((one: any) => one.current)

    expect(current.length).toBe(1)
    expect(current[0]?.device).toBe('Chrome on macOS')

    // And from the other browser, the other row is the current one - so the
    // marker is about the reader rather than about the row.
    const asPhone = await sessions(created.phone, { operation: 'list' })
    const fromPhone = (asPhone.body?.sessions ?? []).filter((one: any) => one.current)

    expect(fromPhone[0]?.device).toBe('Safari on iPhone')
  }, 30_000)

  test('carries the address the request came from', async () => {
    if (!available)
      return

    /*
     * The first entry of `x-forwarded-for`, which is the client as the nearest
     * trusted proxy saw it. The rest of that list is whatever the client
     * claimed.
     *
     * Found by device rather than by position. The registration that created
     * this account is a session too - it sent no forwarded header and no agent
     * of its own - so the list has three rows and only two of them were signed
     * in by this file.
     */
    const answer = await sessions(created.laptop, { operation: 'list' })
    const laptop = (answer.body?.sessions ?? []).find((one: any) => one.device === 'Chrome on macOS')

    expect(laptop?.ip_address).toBe('203.0.113.7')
  }, 30_000)

  test('is your own, and there is no parameter that could say otherwise', async () => {
    if (!available)
      return

    /*
     * A list of where an account signs in from is a list of where a person is,
     * so the rows are found by the caller's own id and nothing else. Passing a
     * user id changes nothing rather than being refused: the parameter does not
     * exist, which is a stronger guarantee than refusing it would be.
     *
     * Checked against the database rather than against the rendered device
     * names - a name is a coincidence away from matching somebody else's, and
     * the property is about ownership.
     */
    const answer = await sessions(created.laptop, { operation: 'list', user_id: 1 })
    const ids = (answer.body?.sessions ?? []).map((one: any) => Number(one.id))

    expect(ids.length).toBeGreaterThan(0)

    const mine: any[] = await (globalThis as any).db
      .selectFrom('oauth_access_tokens')
      .select(['id'])
      .where('user_id', '=', created.userId)
      .execute()

    const owned = new Set(mine.map(row => Number(row.id)))

    expect(ids.filter((id: number) => !owned.has(id))).toEqual([])
  }, 30_000)
})

describe('revoking one', () => {
  test('ends that browser and leaves the other signed in', async () => {
    if (!available)
      return

    const list = await sessions(created.laptop, { operation: 'list' })
    const phone = (list.body?.sessions ?? []).find((one: any) => one.device === 'Safari on iPhone')

    expect(phone).toBeDefined()

    const answer = await sessions(created.laptop, { operation: 'revoke', id: phone.id })
    expect(answer.status).toBe(200)

    // The scope that matters: signing out a device you no longer have must not
    // sign you out of the one you are holding.
    expect(await stillSignedIn(created.phone)).toBe(false)
    expect(await stillSignedIn(created.laptop)).toBe(true)
  }, 30_000)

  test('is recorded in the audit log', async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'session:revoked')
      .where('actor_id', '=', created.userId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(row).not.toBeNull()
    expect(JSON.parse(String(row.detail)).count).toBe(1)
  }, 30_000)

  test('somebody else\'s session id does nothing', async () => {
    if (!available)
      return

    // Scoped in the statement rather than checked and then updated, so an id
    // that is not theirs matches no row - and the answer is the same as for one
    // that was just revoked, because anything else tells whoever is guessing
    // ids which ones exist.
    const other: any = await (globalThis as any).db
      .selectFrom('oauth_access_tokens')
      .select(['id'])
      .where('user_id', '!=', created.userId)
      .where('revoked', '=', false)
      .executeTakeFirst()

    if (!other)
      return

    expect((await sessions(created.laptop, { operation: 'revoke', id: Number(other.id) })).status).toBe(200)

    const after: any = await (globalThis as any).db
      .selectFrom('oauth_access_tokens')
      .select(['revoked'])
      .where('id', '=', Number(other.id))
      .executeTakeFirst()

    expect(Boolean(after?.revoked)).toBe(false)
  }, 30_000)
})

describe('signing out everywhere else', () => {
  test('keeps the browser pressing it', async () => {
    if (!available)
      return

    /*
     * The response to a suspicion, and it has to leave you signed in where you
     * are - otherwise the person who has just realised something is wrong is
     * thrown out of the page where they were dealing with it, which is how they
     * end up not pressing it at all.
     */
    const third = await signIn(AGENTS.phone)

    expect(await stillSignedIn(third)).toBe(true)

    const answer = await sessions(created.laptop, { operation: 'revoke-others' })

    expect(answer.status).toBe(200)
    expect(answer.body?.revoked).toBeGreaterThan(0)
    expect(await stillSignedIn(third)).toBe(false)
    expect(await stillSignedIn(created.laptop)).toBe(true)
  }, 30_000)
})
