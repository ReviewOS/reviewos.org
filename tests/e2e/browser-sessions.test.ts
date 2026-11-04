import { afterAll, beforeAll, expect, test } from 'bun:test'

let server: any
let base = ''
let csrf = { cookie: '', token: '' }
const users: number[] = []
const password = 'owned-browser-session-password'
const handles = [0, 1].map(() => `browser${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`)

beforeAll(async () => {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  const { route } = await import('@stacksjs/router')
  await injectGlobalAutoImports()
  // Fail rather than count a migrated-browser acceptance check as a silent pass.
  await db.selectFrom('auth_browser_sessions').select('id').limit(1).execute()
  await route.importRoutes()
  server = await route.serve({ port: 0, hostname: '127.0.0.1' })
  base = `http://127.0.0.1:${server.port}`
  const seeded = await fetch(`${base}/api/health?quick=1`, { headers: { Accept: 'text/html' } })
  await seeded.text()
  const cookie = seeded.headers.getSetCookie().find(value => value.startsWith('X-CSRF-Token='))?.split(';')[0]
  expect(cookie).toBeDefined()
  csrf = { cookie: cookie!, token: decodeURIComponent(cookie!.slice('X-CSRF-Token='.length)) }
}, 120_000)

afterAll(async () => {
  await server?.stop(true)
  // The enclosing test database owns these accounts and all related rows.
})

function post(path: string, data: Record<string, unknown>, options: { cookie?: string, html?: boolean, csrf?: boolean } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/json', Accept: options.html ? 'text/html' : 'application/json',
      Cookie: `${options.cookie ?? ''}; ${csrf.cookie}`,
      ...(options.csrf === false ? {} : { 'x-csrf-token': csrf.token }),
    },
    body: JSON.stringify(data),
  })
}

function browserCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('session_id=') && !value.includes('Max-Age=0'))
  expect(cookie).toBeDefined()
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  const age = Number(/Max-Age=(\d+)/.exec(cookie!)?.[1])
  expect(age).toBeGreaterThan(2_591_990)
  expect(age).toBeLessThanOrEqual(2_592_000)
  return cookie!.split(';')[0]!
}

async function me(cookie: string, authorization?: string): Promise<Response> {
  const result = await fetch(`${base}/api/user`, { headers: { Cookie: cookie, Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}) } })
  await result.text()
  return result
}

test('browser forms retain a revocable 30-day session after the API bearer expires', async () => {
  const { config } = await import('@stacksjs/config')
  const { findToken, browserSessions } = await import('@stacksjs/auth')
  const registered = await post('/api/auth/register', { handle: handles[0], email: `${handles[0]}@owned.invalid`, name: 'Owned browser', password }, { html: true })
  await registered.text()
  expect(registered.status).toBe(303)
  const cookie = browserCookie(registered)
  const user = await db.selectFrom('users').select('id').where('handle', '=', handles[0]!).executeTakeFirst()
  expect(user).toBeDefined()
  users.push(Number(user!.id))
  expect((await me(cookie)).status).toBe(200)

  const previousExpiry = config.auth.tokenExpiry
  let api: { access_token: string, refresh_token: string, expires_in: number }
  try {
    config.auth.tokenExpiry = 2000
    const signedIn = await post('/api/auth/login', { email: `${handles[0]}@owned.invalid`, password })
    expect(signedIn.status).toBe(200)
    api = await signedIn.json() as typeof api
    expect(api.access_token).toBeTruthy()
    expect(api.refresh_token).toBeTruthy()
    expect(api.expires_in).toBeLessThanOrEqual(2)
  }
  finally { config.auth.tokenExpiry = previousExpiry }
  await Bun.sleep(2200)
  expect(await findToken(api!.access_token)).toBeNull()
  expect((await me(cookie)).status).toBe(200)
  expect((await me(cookie, `Bearer ${api!.access_token}`)).status).toBe(401)
  const viewed = await fetch(`${base}/${handles[0]}`, { headers: { Cookie: cookie, Accept: 'text/html' } })
  expect(viewed.status).toBe(200)
  expect(await viewed.text()).toContain('Sign out')

  const listed = await post('/api/user/sessions', { operation: 'list' }, { cookie })
  expect(listed.status).toBe(200)
  const sessions = (await listed.json() as { sessions: Array<{ id: string, current: boolean }> }).sessions
  const current = sessions.find(session => session.current)
  expect(current?.id).toMatch(/^bs1:[a-f0-9]{64}$/)
  expect((await me(`session_id=${encodeURIComponent(current!.id)}`)).status).toBe(401)
  const denied = await post('/api/user/sessions', { operation: 'revoke', id: current!.id }, { cookie, csrf: false })
  await denied.text()
  expect(denied.status).toBe(403)
  expect((await me(cookie)).status).toBe(200)

  const switched = await post('/api/auth/register', { handle: handles[1], email: `${handles[1]}@owned.invalid`, name: 'Other owned browser', password }, { html: true, cookie })
  await switched.text()
  expect(switched.status).toBe(303)
  const otherCookie = browserCookie(switched)
  const other = await db.selectFrom('users').select('id').where('handle', '=', handles[1]!).executeTakeFirst()
  users.push(Number(other!.id))
  expect((await me(cookie)).status).toBe(401)
  expect((await me(otherCookie)).status).toBe(200)
  expect(await browserSessions(users[0]!)).toHaveLength(0)

  const logout = await post('/api/auth/logout', {}, { cookie: otherCookie, html: true })
  await logout.text()
  expect(logout.status).toBe(303)
  expect(logout.headers.get('Location')).toBe('/')
  expect(logout.headers.getSetCookie().some(value => value.startsWith('session_id=') && value.includes('Max-Age=0'))).toBe(true)
  expect((await me(otherCookie)).status).toBe(401)
}, 120_000)
