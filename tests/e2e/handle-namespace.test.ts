// One namespace, two tables.
//
// `/chris` and `/reviewos` are the same kind of URL, so a user and an
// organization cannot both hold one handle: `resolveOwner` returns whichever
// it finds first, and the loser's profile - and every repository URL under it -
// becomes unreachable on row order. Taking an organization's name is also the
// impersonation the consecutive-hyphen rule in `handles.ts` exists to stop.
//
// `handleAvailable` reads both tables and every organization path has always
// used it. The two user paths each ran their own query against `users` alone,
// so the rule held in one direction and not the other, while `User.ts`
// described it as "the one place that decides whether a handle can be taken".
// These pin both directions, and the case that must keep working.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, handle: '', token: '', orgId: 0, orgHandle: '', registerOrgId: 0, registerOrgHandle: '' }
let available = false
let port = 0
let server: any = null

const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

/** The page, and the CSRF cookie the router seeds on every safe response. */
async function fetchPage(path: string): Promise<{ html: string, csrf: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', Cookie: `auth-token=${created.token}` },
  })
  const seeded = String(answer.headers.get('set-cookie') ?? '').match(/X-CSRF-Token=([^;,\s]+)/i)
  return { html: await answer.text(), csrf: seeded?.[1] ?? '' }
}

/** The `_token` a form carries in its body, as rendered into the page. */
function tokenField(html: string): string {
  return /name\s*=\s*["']_token["'][^>]*value\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? ''
}

/*
 * Submitted the way the browser submits it, which is the only way the web
 * product ever posts this: form encoding, the CSRF token in the body, the
 * session cookie alongside, and `Accept: text/html` so the action answers with
 * a redirect rather than JSON. The bearer-token path exists for the CLI and is
 * a different front door onto the same action.
 */
async function submitProfile(handle: string): Promise<{ status: number, location: string }> {
  const page = await fetchPage('/settings/profile')
  const answer = await fetch(`http://127.0.0.1:${port}/api/user/profile`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `auth-token=${created.token}; X-CSRF-Token=${page.csrf}`,
    },
    body: new URLSearchParams({ _token: tokenField(page.html), handle }),
  })

  return { status: answer.status, location: String(answer.headers.get('location') ?? '') }
}

/** The stored handle, which is the only answer that actually matters. */
async function storedHandle(): Promise<string> {
  const db = (globalThis as any).db
  const row: any = await db.selectFrom('users').select(['handle']).where('id', '=', created.userId).executeTakeFirst()
  return String(row?.handle ?? '')
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

    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')

    created.handle = unique('ns')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Namespace Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.userId = Number(user?.id)

    created.orgHandle = unique('nsorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({ handle: created.orgHandle, name: 'Namespace Org' })
      .returning(['id'])
      .executeTakeFirst()
    created.orgId = Number(organization?.id)

    // A second organization, held back for the registration test. Sharing one
    // handle made that test pass for the wrong reason: the rename above would
    // have already written it onto the user, so "no user holds it" failed as a
    // cascade rather than because registration refused anything.
    created.registerOrgHandle = unique('nsreg')
    const registerOrg: any = await db
      .insertInto('organizations')
      .values({ handle: created.registerOrgHandle, name: 'Namespace Org For Registration' })
      .returning(['id'])
      .executeTakeFirst()
    created.registerOrgId = Number(registerOrg?.id)

    const issued: any = await createToken(created.userId, 'handle namespace test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    available = Boolean(created.userId && created.orgId && created.registerOrgId && created.token)
  }
  catch (error) {
    console.warn(`[handle-namespace] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    for (const id of [created.orgId, created.registerOrgId]) {
      if (id)
        await db.deleteFrom('organizations').where('id', '=', id).execute()
    }
    await db.deleteFrom('users').where('handle', '=', created.registerOrgHandle).execute()
    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* nothing else to release */ }

  try { server?.stop?.(true) }
  catch { /* already down */ }
})

describe('a handle an organization already holds', () => {
  test('cannot be taken by renaming a user into it', async () => {
    if (!available)
      return

    const answer = await submitProfile(created.orgHandle)

    // A browser gets a redirect back to the form carrying the reason, not a
    // bare status page: the four other fields are still filled in.
    expect(answer.status).toBe(303)
    expect(answer.location).toContain('/settings/profile?error=')
    expect(decodeURIComponent(answer.location)).toContain('taken')
  })

  test('and the rename did not happen, which is the part a redirect cannot prove', async () => {
    if (!available)
      return

    // The assertion above would pass against an action that answered 303 and
    // wrote the row anyway.
    expect(await storedHandle()).toBe(created.handle)
  })

  test('nor by registering it, which went through its own query too', async () => {
    if (!available)
      return

    /*
     * Submitted as the register form submits it.
     *
     * The first version of this test posted JSON with no CSRF token and
     * asserted `status >= 400`. It passed against the bug: the 400 was a 403
     * `CSRF token mismatch`, and "no user holds that handle" was true because
     * nothing had been created for an entirely unrelated reason. An assertion
     * that cannot tell a refusal from the refusal it is testing for is worse
     * than no assertion, because it reports as cover.
     */
    const page = await fetch(`http://127.0.0.1:${port}/register`, { headers: { Accept: 'text/html' } })
    const html = await page.text()
    const csrf = String(page.headers.get('set-cookie') ?? '').match(/X-CSRF-Token=([^;,\s]+)/i)?.[1] ?? ''

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `X-CSRF-Token=${csrf}`,
      },
      body: new URLSearchParams({
        _token: tokenField(html),
        handle: created.registerOrgHandle,
        email: `${unique('reg')}@example.com`,
        password: 'a-long-enough-password',
        name: 'Should Not Exist',
      }),
    })

    expect(answer.status).toBe(303)

    const location = decodeURIComponent(String(answer.headers.get('location') ?? ''))

    // Named, so this cannot pass on a CSRF failure or a closed instance again.
    expect(location).toContain('/register?')
    expect(location).toContain('taken')

    const db = (globalThis as any).db
    const rows = await db.selectFrom('users').select(['id']).where('handle', '=', created.registerOrgHandle).execute()
    expect(rows.length).toBe(0)
  })
})

describe('and a handle nobody holds', () => {
  test('is still free, so the fix refuses the collision rather than the rename', async () => {
    if (!available)
      return

    const fresh = unique('ns2')
    const answer = await submitProfile(fresh)

    expect(answer.status).toBe(303)
    expect(answer.location).not.toContain('error=')
    expect(await storedHandle()).toBe(fresh)

    created.handle = fresh
  })
})
