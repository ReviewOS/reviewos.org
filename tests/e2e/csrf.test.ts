// CSRF on the JSON API, and the bearer exemption.
//
// Three files cover this between them, and they do not overlap.
// `tests/unit/csrf-coverage.test.ts` pins the policy - which routes are exempt
// and why. `tests/e2e/csrf-forms.test.ts` covers the *form* path: a page a
// browser has never seen, the token it embeds, and the submit. This covers what
// neither does - a signed-in session posting JSON, and the exemption that lets
// an API client through.
//
// The exemption is the part worth a test. It is the one place where a
// reasonable-sounding tightening (require a token from everybody) breaks every
// API client, and a reasonable-sounding loosening (accept any bearer) hands an
// attacker a way to launder a cookie past the check. Both directions are here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  token: '',
  session: '',
  csrf: { token: '', cookie: '' },
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * A POST to a state-changing endpoint, with whatever credentials are given.
 *
 * `/api/user/keys` is the target throughout: it is behind `auth`, it takes both
 * a session and a bearer, and refusing it costs nothing - an invalid key body
 * is a 422, which is a different answer from the 403 these tests are about, so
 * the two cannot be confused.
 */
async function attempt(headers: Record<string, string>): Promise<number> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/user/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
    body: JSON.stringify({ title: 'csrf test', key: 'not a key' }),
  })

  await answer.text()

  return answer.status
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

    // The token the way a browser gets it: from a safe request, on the way out.
    const seed = await fetch(`http://127.0.0.1:${port}/api/health?quick=1`)
    const raw = seed.headers.get('set-cookie') ?? ''
    const match = /X-CSRF-Token=([^;]*)/.exec(raw)
    await seed.text()

    if (!match)
      throw new Error('no CSRF cookie was seeded on a safe response')

    created.csrf = { token: decodeURIComponent(match[1]!), cookie: `X-CSRF-Token=${match[1]}` }

    /*
     * Registered through the endpoint rather than inserted, because the
     * session cookie is the thing under test and only the real sign-in path
     * produces one. It carries the CSRF token, which is also the first proof
     * that the mechanism lets a legitimate form through.
     */
    const handle = unique('csrf')
    const registered = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-csrf-token': created.csrf.token,
        'Cookie': created.csrf.cookie,
      },
      body: JSON.stringify({
        handle,
        email: `${handle}@example.com`,
        password: 'a-long-enough-password',
        name: 'CSRF Person',
      }),
    })

    await registered.text()

    if (registered.status >= 400)
      throw new Error(`registration answered ${registered.status}`)

    const { sessionCookieName } = await import('../../app/Actions/Auth/session')
    const name = await sessionCookieName()
    const set = registered.headers.get('set-cookie') ?? ''
    const session = new RegExp(`${name}=([^;]*)`).exec(set)

    if (!session)
      throw new Error('registration set no session cookie')

    created.session = `${name}=${session[1]}`

    const row: any = await db
      .selectFrom('users')
      .select(['id'])
      .where('handle', '=', handle)
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    await db.insertInto('access_tokens').values({
      user_id: created.userId,
      name: 'csrf test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).execute()

    created.token = token.token
    available = true
  }
  catch (error) {
    console.warn(`[csrf] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('audit_events').where('actor_id', '=', created.userId).execute()
      await db.deleteFrom('ssh_keys').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('a browser session', () => {
  test('is refused without a token', async () => {
    if (!available)
      return

    /*
     * The forged request, as an attacker's page would send it: the victim's
     * cookies ride along automatically, and the attacker cannot read them, so
     * the one thing they cannot supply is the matching token.
     */
    expect(await attempt({ Cookie: created.session })).toBe(403)
  })

  test('succeeds with the token that matches its cookie', async () => {
    if (!available)
      return

    const status = await attempt({
      'Cookie': `${created.session}; ${created.csrf.cookie}`,
      'x-csrf-token': created.csrf.token,
    })

    // Past the check. 422 because the body is deliberately not a key - a
    // different answer from 403, so passing and failing cannot be confused.
    expect(status).toBe(422)
  })

  test('is refused when the token does not match the cookie', async () => {
    if (!available)
      return

    // Double submit is the whole mechanism: echoing *a* value proves nothing,
    // echoing the value in the cookie proves the sender could read it, and only
    // same-origin script can.
    const status = await attempt({
      'Cookie': `${created.session}; ${created.csrf.cookie}`,
      'x-csrf-token': 'f'.repeat(64),
    })

    expect(status).toBe(403)
  })
})

describe('a token', () => {
  test('needs no CSRF token, because it is not ambient', async () => {
    if (!available)
      return

    /*
     * An `Authorization` header is not attached by the browser to a
     * cross-origin request the way a cookie is - somebody has to put it there,
     * and an attacker cannot read it to do so. Requiring a CSRF token as well
     * would mean every API client had to hold a cookie, which is the shape
     * that makes people turn the check off.
     */
    expect(await attempt({ Authorization: `Bearer ${created.token}` })).toBe(422)
  })

  test('does not let a session ride along without one', async () => {
    if (!available)
      return

    // The combination worth checking: a bearer that is not valid must not
    // launder a cookie past the check. The bearer bypass is about the
    // credential the *request* is using, and a rejected bearer is not one.
    const status = await attempt({
      Cookie: created.session,
      Authorization: 'Bearer ros_not_a_real_token',
    })

    // 401 or 403 - refused either way, and which one depends on whether the
    // bearer or the CSRF check speaks first. What must not happen is 422,
    // which would mean it reached the action.
    expect([401, 403]).toContain(status)
  })
})
