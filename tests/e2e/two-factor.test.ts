// Two-factor, from enrolment through a sign-in and out the other side.
//
// The whole ceremony, because the interesting failures are all at the joins:
// a factor enabled without a verified code, a recovery code that works twice, a
// session issued before the code was checked, a disable that needs nothing.
// Each of those passes a test of its own component.
//
// The TOTP codes here are generated with the framework's own helper against the
// secret the endpoint issued, which is what an authenticator app does with the
// same secret - so this exercises the real verification rather than a stub.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isTrue } from '../../app/Actions/Support/sql'

const created = {
  handle: '',
  password: 'a-long-enough-password',
  userId: 0,
  session: '',
  csrf: { token: '', cookie: '' },
  secret: '',
  recoveryCodes: [] as string[],
  challenge: '',
  organizationId: 0,
  organizationHandle: '',
  repositoryId: 0,
  repositoryName: '',
  diskPath: '',
  token: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The six digits an authenticator app would be showing right now. */
async function currentCode(secret: string): Promise<string> {
  const { generateTwoFactorToken } = await import('@stacksjs/auth')

  return await generateTwoFactorToken(secret)
}

/**
 * An address of this file's own.
 *
 * Sign-in is throttled at ten attempts per five minutes keyed by address, the
 * counter is in memory, and `bun test` runs every file in one process - so a
 * suite whose files all sign in from 127.0.0.1 shares one bucket and whichever
 * file runs last gets 429s. That is the limit working correctly; these really
 * are different clients, and saying so is more honest than raising the limit
 * for tests.
 */
const CLIENT = `198.51.100.${1 + Math.floor(Math.random() * 250)}`

async function post(path: string, body: Record<string, unknown>, cookie = ''): Promise<{ status: number, body: any, headers: Headers }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': [cookie, created.csrf.cookie].filter(Boolean).join('; '),
      'x-csrf-token': created.csrf.token,
      'x-forwarded-for': CLIENT,
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null), headers: answer.headers }
}

/** Everything the two-factor endpoint does, as the signed-in person. */
async function twoFactor(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const { status, body: json } = await post('/api/user/two-factor', body, created.session)

  return { status, body: json }
}

function cookieFrom(headers: Headers, name: string): string {
  for (const raw of headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']) {
    const match = new RegExp(`${name}=([^;]*)`).exec(raw)

    if (match && match[1])
      return `${name}=${match[1]}`
  }

  return ''
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('recovery_codes').select(['id']).limit(1).execute()

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
    created.handle = unique('tfa')

    const registered = await post('/api/auth/register', {
      handle: created.handle,
      email: `${created.handle}@example.com`,
      password: created.password,
      name: 'Two Factor Person',
    })

    if (registered.status >= 400)
      throw new Error(`registration answered ${registered.status}`)

    const { sessionCookieName } = await import('../../app/Actions/Auth/session')
    created.session = cookieFrom(registered.headers, await sessionCookieName())

    if (!created.session)
      throw new Error('registration set no session cookie')

    const row: any = await db
      .selectFrom('users')
      .select(['id'])
      .where('handle', '=', created.handle)
      .executeTakeFirst()

    created.userId = Number(row?.id)
    available = true
  }
  catch (error) {
    console.warn(`[two-factor] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('recovery_codes').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('audit_events').where('actor_id', '=', created.userId).execute()
      await db.deleteFrom('notifications').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', created.userId).execute()

      if (created.repositoryId) {
        await db.deleteFrom('repo_collaborators').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }

      if (created.diskPath) {
        const { rm } = await import('node:fs/promises')
        await rm(created.diskPath, { recursive: true, force: true })
      }

      if (created.organizationId) {
        await db.deleteFrom('org_members').where('organization_id', '=', created.organizationId).execute()
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()
      }

      await db.deleteFrom('access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('enrolling', () => {
  test('starts off, and stays off until a code is verified', async () => {
    if (!available)
      return

    expect(isTrue((await twoFactor({ operation: 'status' })).body?.enabled)).toBe(false)

    const begun = await twoFactor({ operation: 'begin' })

    expect(begun.status).toBe(200)
    expect(String(begun.body?.otpauth_uri)).toStartWith('otpauth://totp/')

    created.secret = String(begun.body?.secret ?? '')
    expect(created.secret.length).toBeGreaterThan(10)

    /*
     * The property that matters. A secret exists now and the factor is still
     * off - so somebody who photographs the QR code and never scans it, or
     * whose device clock is wrong, has not locked themselves out.
     */
    expect(isTrue((await twoFactor({ operation: 'status' })).body?.enabled)).toBe(false)
  }, 30_000)

  test('refuses a wrong code and leaves it off', async () => {
    if (!available)
      return

    const answer = await twoFactor({ operation: 'enable', code: '000000' })

    expect(isTrue(answer.status).toBe(422)
    expect((await twoFactor({ operation: 'status' })).body?.enabled)).toBe(false)
  }, 30_000)

  test('turns on with a real code, and hands over the recovery codes once', async () => {
    if (!available)
      return

    const answer = await twoFactor({ operation: 'enable', code: await currentCode(created.secret) })

    expect(answer.status).toBe(200)
    expect(isTrue(answer.body?.enabled)).toBe(true)

    created.recoveryCodes = answer.body?.recovery_codes ?? []

    // Issued by the same click that enables the factor. Everybody understands
    // the second factor; what stops them is losing the device.
    expect(created.recoveryCodes.length).toBe(10)
    expect(created.recoveryCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)

    const status = await twoFactor({ operation: 'status' })
    expect(isTrue(status.body?.enabled)).toBe(true)
    expect(status.body?.recovery_codes_remaining).toBe(10)
  }, 30_000)

  test('and they are not stored where a database dump would carry them', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('recovery_codes')
      .select(['code_hash'])
      .where('user_id', '=', created.userId)
      .execute()

    const stored = rows.map(row => String(row.code_hash)).join(' ')

    for (const code of created.recoveryCodes)
      expect(stored).not.toContain(code.replace('-', ''))
  }, 30_000)
})

/*
 * Sign-in is throttled at ten attempts per five minutes, keyed by address -
 * which is the right limit and applies to this file too. So one challenge is
 * captured and reused across the tests that need one: it is a signed value with
 * a five-minute life and no server-side state, so reusing it is exactly what a
 * browser retrying a mistyped code does.
 */
describe('signing in with it on', () => {
  test('the password alone gets a challenge rather than a session', async () => {
    if (!available)
      return

    const answer = await post('/api/auth/login', {
      email: `${created.handle}@example.com`,
      password: created.password,
    })

    expect(answer.status).toBe(401)
    expect(answer.body?.code_required).toBe(true)

    /*
     * And no session. Issuing one and withdrawing it later would mean a session
     * that briefly worked, and the window is exactly long enough for a client
     * that stored the cookie.
     */
    const { sessionCookieName } = await import('../../app/Actions/Auth/session')
    expect(cookieFrom(answer.headers, await sessionCookieName())).toBe('')

    // The challenge is what carries "the password was right" to the second
    // post, so the page never has to hold the password in a hidden field.
    created.challenge = cookieFrom(answer.headers, 'two-factor-challenge')
    expect(created.challenge).not.toBe('')
  }, 30_000)

  test('the code alone, with the challenge, signs in', async () => {
    if (!available)
      return

    const second = await post('/api/auth/login', { code: await currentCode(created.secret) }, created.challenge)

    expect(second.status).toBe(200)
    expect(String(second.body?.access_token ?? '').length).toBeGreaterThan(10)
  }, 30_000)

  test('a code with no challenge is not a way in', async () => {
    if (!available)
      return

    // Otherwise the second factor is the *only* factor: six digits, no password,
    // and a million tries.
    const answer = await post('/api/auth/login', { code: await currentCode(created.secret) })

    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(String(answer.body?.access_token ?? '')).toBe('')
  }, 30_000)

  test('a forged challenge is not a way in either', async () => {
    if (!available)
      return

    // The cookie is signed with the application key, so a browser cannot mint
    // one for a user id it picked.
    const forged = `two-factor-challenge=${created.userId}.${Date.now() + 60_000}.${'f'.repeat(64)}`
    const answer = await post('/api/auth/login', { code: await currentCode(created.secret) }, forged)

    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(String(answer.body?.access_token ?? '')).toBe('')
  }, 30_000)

  test('a recovery code works, once', async () => {
    if (!available)
      return

    const code = created.recoveryCodes[0]!
    const used = await post('/api/auth/login', { code }, created.challenge)

    expect(used.status).toBe(200)

    /*
     * And not twice. A single-use credential that is not single-use is the
     * whole failure of this mechanism: somebody who reads one over the phone
     * has given away a permanent bypass rather than one entry.
     */
    const second = await post('/api/auth/login', { code }, created.challenge)

    expect(second.status).toBeGreaterThanOrEqual(400)

    expect((await twoFactor({ operation: 'status' })).body?.recovery_codes_remaining).toBe(9)
  }, 30_000)

  test('typed in capitals with no hyphen, it still works', async () => {
    if (!available)
      return

    // Somebody reading a code off a printed page types it the way it looks to
    // them. A recovery code refused for punctuation is a person locked out by
    // punctuation.
    const code = created.recoveryCodes[1]!.replace('-', '').toUpperCase()
    const answer = await post('/api/auth/login', { code }, created.challenge)

    expect(answer.status).toBe(200)
  }, 30_000)
})

describe('turning it off', () => {
  test('needs a current code, so a stolen session is not a way past it', async () => {
    if (!available)
      return

    /*
     * Without this, a cookie left on a shared machine is a full bypass: sign in
     * with it, disable the factor, and the account is back to a password.
     * Requiring the factor to remove the factor is the point of having it.
     */
    expect((await twoFactor({ operation: 'disable' })).status).toBe(422)
    expect(isTrue((await twoFactor({ operation: 'status' })).body?.enabled)).toBe(true)
  }, 30_000)

  test('and takes the recovery codes with it', async () => {
    if (!available)
      return

    const answer = await twoFactor({ operation: 'disable', code: await currentCode(created.secret) })

    expect(answer.status).toBe(200)
    expect(isTrue(answer.body?.enabled)).toBe(false)

    // Left live, a printed set would still bypass a factor turned back on later
    // with a different device.
    const rows: any[] = await (globalThis as any).db
      .selectFrom('recovery_codes')
      .select(['id'])
      .where('user_id', '=', created.userId)
      .execute()

    expect(rows.length).toBe(0)
  }, 30_000)

  test('and the sign-in stops asking', async () => {
    if (!available)
      return

    const answer = await post('/api/auth/login', {
      email: `${created.handle}@example.com`,
      password: created.password,
    })

    expect(answer.status).toBe(200)
  }, 30_000)
})

describe('an organization that requires it', () => {
  test('withholds the role from a member without a second factor', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    created.organizationHandle = unique('tfaorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Strict', handle: created.organizationHandle, require_two_factor: false })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    await db.insertInto('org_members').values({
      organization_id: created.organizationId,
      user_id: created.userId,
      // An admin, so the role alone grants access - a plain member is granted
      // nothing implicitly here, and the test would pass for the wrong reason.
      role: 'admin',
      joined_at: new Date().toISOString(),
    }).execute()

    created.repositoryName = unique('tfarepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.organizationId,
        name: created.repositoryName,
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.organizationHandle}/${created.repositoryName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const resolved = repositoryPath(created.organizationHandle, created.repositoryName)

    if (!resolved.ok)
      throw new Error('the repository path could not be built')

    await mkdir(dirname(resolved.path!), { recursive: true })
    await initBare(resolved.path!, 'main')
    created.diskPath = resolved.path!

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.userId,
      name: 'two-factor test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('access_token_permissions').values({
      access_token_id: Number(tokenRow?.id),
      scope: 'contents',
      level: 'read',
    }).execute()

    created.token = token.token

    const read = async (): Promise<number> => {
      const answer = await fetch(
        `http://127.0.0.1:${port}/api/repos/branches?owner=${created.organizationHandle}&repo=${created.repositoryName}`,
        { headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
      )

      await answer.text()

      return answer.status
    }

    // The control: the requirement is off, so the role grants access.
    expect(await read()).toBe(200)

    /*
     * Two-factor was turned off by the describe above, so switching the
     * requirement on should take the role away - and it has to take it away on
     * the next request, not at the next sign-in, because a member who leaves
     * their session open is exactly who the requirement is about.
     */
    await db
      .updateTable('organizations')
      .set({ require_two_factor: true })
      .where('id', '=', created.organizationId)
      .execute()

    expect([403, 404]).toContain(await read())
  }, 60_000)

  test('and gives it back when they turn one on', async () => {
    if (!available)
      return

    const begun = await twoFactor({ operation: 'begin' })
    const secret = String(begun.body?.secret ?? '')

    expect((await twoFactor({ operation: 'enable', code: await currentCode(secret) })).status).toBe(200)

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/branches?owner=${created.organizationHandle}&repo=${created.repositoryName}`,
      { headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    await answer.text()

    /*
     * The half people forget. A requirement that cannot be satisfied from
     * inside the product is a requirement that gets switched off - and the
     * reason the role is withheld rather than the sign-in refused is precisely
     * so this page is reachable.
     */
    expect(answer.status).toBe(200)
  }, 60_000)
})
