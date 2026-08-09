// Rate limiting, against the real routes.
//
// The whole suite passing is evidence the limits do not get in the way, which
// is half of what matters and the easier half. This is the other half: that
// they refuse, that they say when to come back, and that the bucket is the
// credential rather than the address - because a limit keyed on the address is
// a limit an office shares.
//
// The buckets are process-local, so this resets them between tests. That is
// also the honest way to test a limiter: a test that depends on how many
// requests some earlier file made is a test that fails for reasons nobody can
// read.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  handle: '',
  token: '',
  tokenId: 0,
  otherToken: '',
  otherTokenId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function login(): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.invalid', password: 'wrong' }),
  })
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

    created.handle = unique('thr')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Throttled', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const issue = async () => {
      const token = generateToken()
      const row: any = await db
        .insertInto('access_tokens')
        .values({
          user_id: created.userId,
          name: 'throttle test',
          prefix: token.prefix,
          token_hash: token.hash,
          selection: 'all',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .returning(['id'])
        .executeTakeFirst()

      return { token: token.token, id: Number(row?.id) }
    }

    const first = await issue()
    created.token = first.token
    created.tokenId = first.id

    const second = await issue()
    created.otherToken = second.token
    created.otherTokenId = second.id

    available = true
  }
  catch (error) {
    console.warn(`[throttle] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

beforeEach(async () => {
  if (!available)
    return

  const { resetBuckets } = await import('../../app/Middleware/Throttle')
  resetBuckets()
})

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('signing in', () => {
  test('is refused after ten attempts', async () => {
    if (!available)
      return

    /*
     * The one endpoint where the limit *is* the security control: without it a
     * password is only as good as how fast somebody can guess, and a modern
     * machine guesses quickly.
     */
    const statuses: number[] = []

    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push((await login()).status)

    // The first ten are answered by the action - wrongly, since the password is
    // wrong - and the eleventh is not answered by it at all.
    expect(statuses.slice(0, 10).every(status => status !== 429)).toBe(true)
    expect(statuses[10]).toBe(429)
  }, 30_000)

  test('and says when to come back', async () => {
    if (!available)
      return

    for (let attempt = 0; attempt < 11; attempt += 1)
      await login()

    const refused = await login()
    const body: any = await refused.json().catch(() => null)

    // In the header and the body both: a client on a generic HTTP layer reads
    // one and a client written against this API reads the other, and sending
    // only one means half of them busy-loop.
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(body?.error?.code).toBe('rate_limited')
    expect(body?.error?.retryAfter).toBeGreaterThan(0)
  }, 30_000)

  test('and a refusal does not extend the lockout', async () => {
    if (!available)
      return

    /*
     * Counting a refused request would let a client already being refused push
     * its own window out by retrying - which is exactly what the loop this
     * defends against does.
     */
    for (let attempt = 0; attempt < 11; attempt += 1)
      await login()

    const first = Number((await login()).headers.get('Retry-After'))

    for (let attempt = 0; attempt < 5; attempt += 1)
      await login()

    const later = Number((await login()).headers.get('Retry-After'))

    // The window is running down, not being pushed out.
    expect(later).toBeLessThanOrEqual(first)
  }, 30_000)
})

describe('the bucket', () => {
  test('is the token, not the address', async () => {
    if (!available)
      return

    /*
     * The property the whole override exists for. Both tokens are on the same
     * account and the same address; one exhausting its budget must not exhaust
     * the other's, because the first bad retry loop would otherwise take
     * everything on the account down with it.
     */
    const ask = async (token: string) => await fetch(`http://127.0.0.1:${port}/api/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    // A tiny limit is not configurable per test, so this asserts the keying
    // rather than the exhaustion: two tokens produce two buckets, and the
    // headers prove it - each reports its own remaining count from a full
    // budget rather than a shared, decremented one.
    const first = await ask(created.token)
    await ask(created.token)
    await ask(created.token)

    const other = await ask(created.otherToken)

    expect(first.headers.get('X-RateLimit-Remaining')).toBe(other.headers.get('X-RateLimit-Remaining'))
  })

  test('and the headers are on every response, not only the refusal', async () => {
    if (!available)
      return

    // A client that only learns its budget when it runs out cannot pace itself,
    // only recover. Publishing the limit is the entire point of having one.
    const answer = await fetch(`http://127.0.0.1:${port}/api/user`, {
      headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' },
    })

    expect(answer.status).toBe(200)
    expect(answer.headers.get('X-RateLimit-Limit')).toBeTruthy()
    expect(answer.headers.get('X-RateLimit-Remaining')).toBeTruthy()
    expect(answer.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })
})
