// The settings an administrator changes without a deploy, and the places they
// actually take effect.
//
// The endpoint is the easy half. What these are really for is the other half:
// a switch that does nothing is worse than no switch, because an administrator
// turns registration off, sees it off, and finds out otherwise from a
// stranger's account. So every setting exercised here is exercised through the
// path it governs, not by reading it back.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  adminId: 0,
  adminToken: '',
  personId: 0,
  personToken: '',
  personHandle: '',
  repositoryIds: [] as number[],
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * A CSRF token, obtained the way a browser obtains one.
 *
 * A bearer request does not need one - the check defends the browser's ambient
 * credential - but the registration path here is deliberately anonymous, and
 * anonymous POST is exactly what the check is for. Primed rather than exempted:
 * a test that turned the check off would be testing an endpoint the product
 * does not ship.
 */
let csrf = { token: '', cookie: '' }

async function primeCsrf(): Promise<void> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/health?quick=1`)
  const raw = answer.headers.get('set-cookie') ?? ''
  const match = /X-CSRF-Token=([^;]*)/.exec(raw)

  await answer.text()

  if (match)
    csrf = { token: decodeURIComponent(match[1]!), cookie: `X-CSRF-Token=${match[1]}` }
}

async function post(path: string, body: Record<string, unknown>, token?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(csrf.token ? { 'x-csrf-token': csrf.token, 'Cookie': csrf.cookie } : {}),
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Set a setting the way an administrator would, through the endpoint. */
async function set(key: string, value: string): Promise<number> {
  return (await post('/api/instance/settings', { key, value }, created.adminToken)).status
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('instance_settings').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    await primeCsrf()

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const make = async (prefix: string, admin: boolean) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Settings Person', email: `${handle}@example.com`, handle, password: 'x', is_admin: admin })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const token = generateToken()

      const tokenRow: any = await db.insertInto('access_tokens').values({
        user_id: id,
        name: 'settings test',
        prefix: token.prefix,
        token_hash: token.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).returning(['id']).executeTakeFirst()

      await db.insertInto('access_token_permissions').values({
        access_token_id: Number(tokenRow?.id),
        scope: 'administration',
        level: 'admin',
      }).execute()

      // Creating a repository needs contents, not administration.
      await db.insertInto('access_token_permissions').values({
        access_token_id: Number(tokenRow?.id),
        scope: 'contents',
        level: 'write',
      }).execute()

      return { id, token: token.token, handle }
    }

    const admin = await make('setadmin', true)
    created.adminId = admin.id
    created.adminToken = admin.token

    const person = await make('setperson', false)
    created.personId = person.id
    created.personToken = person.token
    created.personHandle = person.handle

    available = true
  }
  catch (error) {
    console.warn(`[instance-settings] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterEach(async () => {
  if (!available)
    return

  /*
   * Back to the defaults after every test, by deleting the rows rather than
   * writing the old value back.
   *
   * A setting is absent until somebody sets it, so deleting is what "unset"
   * means here - and this table is shared by every test in the process, so a
   * `registration: closed` left behind would fail whichever registration test
   * ran next with a message about the wrong thing entirely.
   */
  try {
    await (globalThis as any).db.deleteFrom('instance_settings').execute()
  }
  catch {
    // The table is gone, which means the suite is running against a database
    // somebody just reset. `available` is already false in that case and every
    // test returns early - a hook that threw here would report the reset as a
    // failure in whichever test happened to run last.
  }

  const { forgetSettings } = await import('../../app/Ops/settings')
  forgetSettings()
})

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const users = [created.adminId, created.personId].filter(Boolean)

      await db.deleteFrom('instance_settings').execute()

      if (created.repositoryIds.length > 0)
        await db.deleteFrom('repositories').where('id', 'in', created.repositoryIds).execute()

      if (users.length > 0) {
        await db.deleteFrom('audit_events').where('actor_id', 'in', users).execute()
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('who may change them', () => {
  test('an administrator reads every setting with its definition', async () => {
    if (!available)
      return

    const answer = await post('/api/instance/settings', {}, created.adminToken)

    expect(answer.status).toBe(200)

    const registration = (answer.body?.settings ?? []).find((one: any) => one.key === 'registration')

    // The definition beside the value, so a page built against this does not
    // hard-code the same list a second time - and the second copy is the one
    // that goes stale.
    expect(registration?.value).toBe('open')
    expect(registration?.allowed).toEqual(['open', 'closed'])
    expect(String(registration?.describes).length).toBeGreaterThan(10)
  }, 30_000)

  test('an ordinary account gets a 404, not a 403', async () => {
    if (!available)
      return

    // Whether an endpoint exists is not something to confirm to somebody who
    // may not use it.
    expect((await post('/api/instance/settings', {}, created.personToken)).status).toBe(404)
  }, 30_000)

  test('a request with no credential at all does not get in either', async () => {
    if (!available)
      return

    /*
     * 403 rather than 404, and that is CSRF answering first.
     *
     * Every POST in this application is behind it, so the refusal is the same
     * one an anonymous POST to any endpoint gets and confirms nothing about
     * this one in particular. The 404-not-403 promise above is about the case
     * that would otherwise be an oracle: a real, valid credential belonging to
     * somebody who is not an administrator.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/instance/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
    })

    expect([403, 404]).toContain(answer.status)
  }, 30_000)
})

describe('validation', () => {
  test('an unknown key is a 404', async () => {
    if (!available)
      return

    expect(await set('registration_mode', 'open')).toBe(404)
  }, 30_000)

  test('a value outside the enum is a 422 that lists what is allowed', async () => {
    if (!available)
      return

    const answer = await post('/api/instance/settings', { key: 'registration', value: 'invite' }, created.adminToken)

    expect(answer.status).toBe(422)
    expect(String(answer.body?.error)).toContain('open, closed')
  }, 30_000)
})

describe('registration', () => {
  test('closed refuses a new account', async () => {
    if (!available)
      return

    expect(await set('registration', 'closed')).toBe(200)

    const handle = unique('refused')
    const answer = await post('/api/auth/register', {
      handle,
      email: `${handle}@example.com`,
      password: 'a-long-enough-password',
      name: 'Refused',
    })

    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(String(answer.body?.error ?? '')).toContain('not accepting new accounts')

    const row: any = await (globalThis as any).db
      .selectFrom('users')
      .select(['id'])
      .where('handle', '=', handle)
      .executeTakeFirst()

    // The switch, not a message. A refusal that still creates the account is
    // the exact failure this whole file is about.
    expect(row).toBeUndefined()
  }, 30_000)

  test('the refusal comes before the handle is checked', async () => {
    if (!available)
      return

    /*
     * Every check below the gate is a small disclosure to somebody who is not
     * allowed an account here - "that handle is taken" tells a stranger which
     * handles exist.
     */
    await set('registration', 'closed')

    const answer = await post('/api/auth/register', {
      handle: created.personHandle,
      email: 'someone@example.com',
      password: 'a-long-enough-password',
      name: 'Refused',
    })

    expect(String(answer.body?.error ?? '')).toContain('not accepting new accounts')
    expect(String(answer.body?.error ?? '')).not.toContain('taken')
  }, 30_000)
})

describe('repository defaults and limits', () => {
  test('a new repository takes the instance default when none is asked for', async () => {
    if (!available)
      return

    expect(await set('default_repository_visibility', 'private')).toBe(200)

    const name = unique('setrepo')
    const answer = await post('/api/repos', { owner: created.personHandle, name }, created.personToken)

    // Creating a repository writes to disk, so a failure here is an
    // environment problem rather than a settings one - asserted loudly so it
    // does not read as the setting not working.
    expect(answer.status).toBe(201)

    const row: any = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['id', 'visibility'])
      .where('name', '=', name)
      .executeTakeFirst()

    created.repositoryIds.push(Number(row?.id))
    expect(String(row?.visibility)).toBe('private')
  }, 30_000)

  test('an explicit visibility still wins over the default', async () => {
    if (!available)
      return

    // This is a default, not a policy. A policy that overrode an explicit
    // request would break every client that sends one.
    await set('default_repository_visibility', 'private')

    const name = unique('setrepo')
    const answer = await post('/api/repos', { owner: created.personHandle, name, visibility: 'public' }, created.personToken)

    expect(answer.status).toBe(201)

    const row: any = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['id', 'visibility'])
      .where('name', '=', name)
      .executeTakeFirst()

    created.repositoryIds.push(Number(row?.id))
    expect(String(row?.visibility)).toBe('public')
  }, 30_000)

  test('the per-account limit refuses one over', async () => {
    if (!available)
      return

    const owned: any[] = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', 'user')
      .where('owner_id', '=', created.personId)
      .execute()

    // Set the limit to exactly what this account already has, so the next one
    // is the one over. Counted by reading the rows rather than with an
    // aggregate, because the test should not depend on the query builder's
    // aggregate spelling to prove a limit works.
    expect(await set('max_repositories_per_user', String(owned.length))).toBe(200)

    const answer = await post('/api/repos', { owner: created.personHandle, name: unique('setrepo') }, created.personToken)

    expect(answer.status).toBe(422)
    expect(String(answer.body?.error ?? '')).toContain('per account')
  }, 30_000)

  test('zero means no limit, which is the default', async () => {
    if (!available)
      return

    await set('max_repositories_per_user', '0')

    const name = unique('setrepo')
    const answer = await post('/api/repos', { owner: created.personHandle, name }, created.personToken)

    expect(answer.status).toBe(201)

    const row: any = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['id'])
      .where('name', '=', name)
      .executeTakeFirst()

    created.repositoryIds.push(Number(row?.id))
  }, 30_000)
})

describe('the record', () => {
  test('a change is in the audit log, with both sides', async () => {
    if (!available)
      return

    await set('registration', 'closed')

    const row: any = await (globalThis as any).db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'instance:setting-changed')
      .where('actor_id', '=', created.adminId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(row).not.toBeNull()

    const detail = JSON.parse(String(row.detail))
    expect(detail.key).toBe('registration')
    expect(detail.from).toBe('open')
    expect(detail.to).toBe('closed')
  }, 30_000)
})
