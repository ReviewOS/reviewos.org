// Forgotten passwords and unverified addresses, through the real routes.
//
// The rule worth a test is the one that is invisible when it breaks: **the
// request half answers identically whether the address is registered here or
// not.** Reporting the difference turns a public form into a way to test who
// has an account on this forge, which on a forge also answers "does this person
// work here" - and nothing about the page looks wrong when it starts telling
// people apart, because the difference is a status code nobody reads.
//
// The token machinery itself is the framework's and is tested there. What is
// asserted here is the wiring: that a request for a real address writes a row,
// that the reply is the same either way, and that the page renders both halves.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. It needs no git and no mail transport - a send that fails
// is swallowed on purpose, for exactly the reason above.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, email: '', token: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function page(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return await answer.text()
}

/**
 * A CSRF token, obtained the way a browser obtains one.
 *
 * The router checks a double submit on every non-safe method, and these are
 * unauthenticated POSTs - there is no bearer to bypass it with, which is
 * exactly right: a forced password reset is a real attack and the check should
 * stay. So the token is primed **from the page that carries the form**, which
 * is what a person does, and which only works because the router seeds the
 * cookie on file-based views as of Stacks 0.70.312. Before that it did not, and
 * every form in this product was refused for a first-time visitor.
 */
let csrf = { token: '', cookie: '' }

async function primeCsrf(): Promise<void> {
  const answer = await fetch(`http://127.0.0.1:${port}/forgot-password`, { headers: { Accept: 'text/html' } })
  const raw = answer.headers.get('set-cookie') ?? ''
  const match = /X-CSRF-Token=([^;]*)/.exec(raw)

  await answer.text()

  if (match)
    csrf = { token: decodeURIComponent(match[1]), cookie: `X-CSRF-Token=${match[1]}` }
}

async function post(path: string, body: Record<string, unknown>, token?: string): Promise<{ status: number, json: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf.token ? { 'x-csrf-token': csrf.token } : {}),
      ...(csrf.cookie ? { Cookie: csrf.cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, json: await answer.json().catch(() => null) }
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

    const handle = unique('pwr')
    created.email = `${handle}@example.com`

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Reset Person', email: created.email, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.userId, 'password reset test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    await primeCsrf()

    available = true
  }
  catch (error) {
    console.warn(`[password-reset] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('password_resets').where('email', '=', created.email).execute()
      await db.deleteFrom('email_verifications').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('asking for a reset link', () => {
  test('answers the same for an address that has an account', async () => {
    if (!available)
      return

    const asked = await post('/api/auth/password/reset', { email: created.email, operation: 'request' })

    expect(asked.status).toBe(200)
    expect(asked.json?.sent).toBe(true)
  })

  test('and for one that does not', async () => {
    if (!available)
      return

    /*
     * The assertion the whole design hangs on. The framework's `sendEmail`
     * throws for an unknown address and a dead mail transport throws too, and
     * both are swallowed so the two cannot be told apart from outside.
     */
    const asked = await post('/api/auth/password/reset', {
      email: `${unique('nobody')}@example.com`,
      operation: 'request',
    })

    expect(asked.status).toBe(200)
    expect(asked.json?.sent).toBe(true)
  })

  test('refuses a request with no address at all', async () => {
    if (!available)
      return

    // Not the same case: this is a malformed request rather than an unknown
    // address, and answering it with a cheerful "sent" would be a lie that
    // hides a broken form.
    const asked = await post('/api/auth/password/reset', { operation: 'request' })

    expect(asked.status).toBe(422)
  })
})

describe('using a reset link', () => {
  test('refuses a token that was never issued', async () => {
    if (!available)
      return

    const used = await post('/api/auth/password/reset', {
      email: created.email,
      operation: 'reset',
      token: 'not-a-real-token',
      password: 'a-long-enough-password',
    })

    expect(used.status).toBe(422)
  })

  test('refuses a password under the floor before it touches the token', async () => {
    if (!available)
      return

    // A reset is the one moment somebody is guaranteed to be choosing a
    // password, so it is a strange place to accept a weaker one than
    // registration would.
    const used = await post('/api/auth/password/reset', {
      email: created.email,
      operation: 'reset',
      token: 'anything',
      password: 'short',
    })

    expect(used.status).toBe(422)
    expect(String(used.json?.error ?? '')).toContain('8 characters')
  })
})

describe('the page', () => {
  test('asks for an address when there is no token', async () => {
    if (!available)
      return

    const html = await page('/forgot-password')

    expect(html).toContain('Send a reset link')
    // And says the flat answer is deliberate, so it does not read as the page
    // failing to notice.
    expect(html).toContain('same whether or not that address has an account')
  })

  test('asks for a new password when there is one', async () => {
    if (!available)
      return

    const html = await page('/forgot-password?token=abc&email=someone%40example.com')

    expect(html).toContain('Choose a new password')
    expect(html).toContain('value="abc"')
  })

  test('and the sign-in page links to it', async () => {
    if (!available)
      return

    // It existed as a URL nothing pointed at once already in this codebase.
    const html = await page('/login')

    expect(html).toContain('/forgot-password')
  })
})

describe('verifying an address', () => {
  test('refuses a link with no token', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/verify?id=${created.userId}`)

    expect(answer.status).toBe(422)
  })

  test('refuses a token that was never issued', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/verify?id=${created.userId}&token=nope`)

    expect(answer.status).toBe(422)

    // And the account stays unverified, which is the part that matters.
    const row: any = await (globalThis as any).db
      .selectFrom('users')
      .select(['email_verified_at'])
      .where('id', '=', created.userId)
      .executeTakeFirst()

    expect(row?.email_verified_at).toBeFalsy()
  })

  test('resending needs somebody to resend for', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/verify/resend`, { method: 'POST' })

    expect([401, 403]).toContain(answer.status)
  })

  test('and issues a fresh token for a signed-in reader', async () => {
    if (!available)
      return

    const sent = await post('/api/auth/verify/resend', {}, created.token)

    expect(sent.status).toBe(200)

    // The row is the evidence. Whether the mail went out is the transport's
    // business and is deliberately not reported to the caller.
    const rows: any[] = await (globalThis as any).db
      .selectFrom('email_verifications')
      .select(['user_id'])
      .where('user_id', '=', created.userId)
      .execute()

    expect(rows).toHaveLength(1)
  })
})
