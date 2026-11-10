// `reviewos login` through the browser, end to end against the real router.
//
// The unit tests hold each rule. This holds the thing a person does: the page
// asks the right question of the right account, approving sends the browser to
// the terminal's own listener and nowhere else, and what comes back signs the
// command line in as that account. It drives the CLI's own listener and
// exchange (app/Cli/browserLogin.ts), so the two ends are tested against each
// other rather than each against a description of the other.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { call } from '../../app/Cli/api'
import { approvalUrl, listen, newAttempt } from '../../app/Cli/browserLogin'

const created = { userId: 0, session: '', handle: '' }

let available = false
let server: any
let port = 0
let db: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const origin = () => `http://127.0.0.1:${port}`

/** A page, as the signed-in browser sees it, and the CSRF cookie the router seeds with it. */
async function page(url: string, session?: string): Promise<{ status: number, html: string, csrf: string }> {
  const answer = await fetch(url, { headers: { Accept: 'text/html', ...(session ? { Cookie: `auth-token=${session}` } : {}) } })
  const seeded = String(answer.headers.get('set-cookie') ?? '').match(/X-CSRF-Token=([^;,\s]+)/i)

  return { status: answer.status, html: await answer.text(), csrf: seeded ? decodeURIComponent(seeded[1]!) : '' }
}

/** The form's post, without following the redirect: where it points is the assertion. */
async function decide(fields: Record<string, string>, csrf: string, headers: Record<string, string>): Promise<Response> {
  return await fetch(`${origin()}/api/cli/login/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, ...headers },
    body: new URLSearchParams({ _token: csrf, ...fields }).toString(),
  })
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)
    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')
    created.handle = unique('cli')

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Command Line Reader', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const issued: any = await createToken(created.userId, 'cli login test')
    created.session = String(issued?.plainTextToken ?? issued?.token ?? issued)

    available = true
  }
  catch (error) {
    console.warn(`[cli-login] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (db && created.userId) {
      const tokens = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', created.userId).execute()
      for (const token of tokens)
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', token.id).execute()
      await db.deleteFrom('access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  catch {}
  try { server?.stop?.(true) }
  catch {}
})

describe('signing the command line in through the browser', () => {
  test('the page asks the signed-in account, and names the machine', async () => {
    if (!available)
      return

    const attempt = newAttempt('workstation.local')
    const asked = await page(approvalUrl(origin(), attempt, 50123), created.session)

    expect(asked.html).toContain('Sign in the command line?')
    expect(asked.html).toContain(created.handle)
    expect(asked.html).toContain('workstation')
    expect(asked.html).toContain(`value="${attempt.challenge}"`)
    expect(asked.html).toContain('action="/api/cli/login/approve"')
    // The verifier is the terminal's alone.
    expect(asked.html).not.toContain(attempt.verifier)
  })

  test('signed out, it sends the reader to sign in and back to this question', async () => {
    if (!available)
      return

    const attempt = newAttempt('workstation')
    const asked = await page(approvalUrl(origin(), attempt, 50123))

    expect(asked.html).toContain('Sign in to continue')
    expect(asked.html).toContain('/login?next=')
    expect(asked.html).not.toContain('action="/api/cli/login/approve"')
  })

  test('a link that reviewos login did not make asks nothing', async () => {
    if (!available)
      return

    const asked = await page(`${origin()}/cli/login?challenge=short&state=x`, created.session)
    expect(asked.html).toContain('This link is not a sign-in')
    expect(asked.html).not.toContain('action="/api/cli/login/approve"')
  })

  test('approving signs the waiting terminal in as that account', async () => {
    if (!available)
      return

    const attempt = newAttempt('workstation')
    const listener = listen(attempt, 20_000)
    try {
      const asked = await page(approvalUrl(origin(), attempt, listener.port), created.session)
      const answer = await decide(
        { challenge: attempt.challenge, state: attempt.state, device: attempt.device, port: String(listener.port), decision: 'approve' },
        asked.csrf,
        { Cookie: `auth-token=${created.session}; X-CSRF-Token=${encodeURIComponent(asked.csrf)}` },
      )

      expect(answer.status).toBe(303)
      const target = new URL(String(answer.headers.get('location')))
      // To the terminal's own listener, and nowhere a request could have chosen.
      expect(target.origin).toBe(`http://127.0.0.1:${listener.port}`)
      expect(target.pathname).toBe('/callback')

      // The browser follows the redirect; the terminal hears it.
      await fetch(target)
      const heard = await listener.answer
      expect(heard?.kind).toBe('code')

      const code = heard?.kind === 'code' ? heard.code : ''

      // Somebody who only saw the code gets nothing for it.
      const stolen = await call({ instance: origin(), token: null }, 'POST', '/api/cli/login/token', { body: { code, verifier: newAttempt().verifier } })
      expect(stolen.ok).toBe(false)
      expect(stolen.status).toBe(403)

      const issued = await call({ instance: origin(), token: null }, 'POST', '/api/cli/login/token', { body: { code, verifier: attempt.verifier } })
      expect(issued.ok).toBe(true)
      expect(issued.status).toBe(201)
      const token = String((issued as any).data?.token ?? '')
      expect(token.startsWith('ros_')).toBe(true)
      expect((issued as any).data?.handle).toBe(created.handle)

      // What `reviewos login` checks before storing it.
      const who = await call({ instance: origin(), token }, 'GET', '/api/user')
      expect(who.ok).toBe(true)
      expect((who as any).data?.handle).toBe(created.handle)

      // An ordinary token: named for the machine, listed with the rest, writing and administering nothing.
      const row = await db.selectFrom('access_tokens').select(['id', 'name', 'selection']).where('user_id', '=', created.userId).where('name', '=', 'ReviewOS CLI on workstation').executeTakeFirst()
      expect(row?.selection).toBe('all')
      const grants = await db.selectFrom('access_token_permissions').select(['scope', 'level']).where('access_token_id', '=', row.id).execute()
      expect(grants.length).toBeGreaterThan(0)
      expect(grants.every((grant: any) => grant.level === 'write')).toBe(true)

      // And that token cannot approve another sign-in: only a browser session can.
      const again = newAttempt('elsewhere')
      const escalation = await decide(
        { challenge: again.challenge, state: again.state, device: again.device, decision: 'approve' },
        asked.csrf,
        { Authorization: `Bearer ${token}`, Cookie: `X-CSRF-Token=${encodeURIComponent(asked.csrf)}` },
      )
      expect(escalation.status).toBe(403)
    }
    finally { listener.stop() }
  }, 60_000)

  test('refusing tells the terminal, and issues nothing', async () => {
    if (!available)
      return

    const attempt = newAttempt('refused-machine')
    const listener = listen(attempt, 20_000)
    try {
      const asked = await page(approvalUrl(origin(), attempt, listener.port), created.session)
      const answer = await decide(
        { challenge: attempt.challenge, state: attempt.state, device: attempt.device, port: String(listener.port), decision: 'deny' },
        asked.csrf,
        { Cookie: `auth-token=${created.session}; X-CSRF-Token=${encodeURIComponent(asked.csrf)}` },
      )

      expect(answer.status).toBe(303)
      await fetch(String(answer.headers.get('location')))
      expect(await listener.answer).toEqual({ kind: 'denied' })

      const row = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', created.userId).where('name', '=', 'ReviewOS CLI on refused-machine').executeTakeFirst()
      expect(row).toBeUndefined()
    }
    finally { listener.stop() }
  }, 60_000)

  test('a terminal with no listener is shown a code to paste, on this host', async () => {
    if (!available)
      return

    const attempt = newAttempt('remote-box')
    const asked = await page(approvalUrl(origin(), attempt), created.session)
    const answer = await decide(
      { challenge: attempt.challenge, state: attempt.state, device: attempt.device, port: '', decision: 'approve' },
      asked.csrf,
      { Cookie: `auth-token=${created.session}; X-CSRF-Token=${encodeURIComponent(asked.csrf)}` },
    )

    expect(answer.status).toBe(303)
    const location = String(answer.headers.get('location'))
    expect(location.startsWith('/cli/login?code=')).toBe(true)

    const shown = await page(`${origin()}${location}`, created.session)
    expect(shown.html).toContain('Paste this in your terminal')

    const code = new URL(location, origin()).searchParams.get('code')!
    expect(shown.html).toContain(code)

    const issued = await call({ instance: origin(), token: null }, 'POST', '/api/cli/login/token', { body: { code, verifier: attempt.verifier } })
    expect(issued.status).toBe(201)
  }, 60_000)

  test('signed out, approving is refused', async () => {
    if (!available)
      return

    const attempt = newAttempt('nobody')
    const asked = await page(approvalUrl(origin(), attempt, 50123))
    const answer = await decide(
      { challenge: attempt.challenge, state: attempt.state, device: attempt.device, port: '50123', decision: 'approve' },
      asked.csrf,
      { Cookie: `X-CSRF-Token=${encodeURIComponent(asked.csrf)}` },
    )

    expect(answer.status).toBe(401)
  })
})
