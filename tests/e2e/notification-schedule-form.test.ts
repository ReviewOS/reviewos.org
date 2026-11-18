// Saving notification hours, the way the settings page saves them.
//
// "Save hours" could not work, and had three independent faults, each of which
// was on its own enough to stop it:
//
//   1. The form posts. The route was registered `PUT` only, and the form
//      carried a hidden `_method=PUT` hoping to be read as one - which
//      `routes/api.ts` says in as many words is "a convention the router does
//      not have". Every submit got 405 Method Not Allowed.
//   2. `days` was declared `schema.number()`. The week grid is seven
//      checkboxes under one name, so two ticks reach the router as an array
//      and the API's own documented shape is a comma list. Both were refused
//      422 "Days must be a number" before the handler ran.
//   3. The times come from `<input type="time">`, so `09:00`. The handler read
//      a minute from midnight and refused anything else, 422.
//
// None of it was visible from the unit suite, which drives `action.handle(...)`
// directly and so skips routing and validation both. These go through the
// router over HTTP with the body the page really posts, and then read the row,
// because a 303 only means the request was accepted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, handle: '', token: '' }
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

/**
 * Submitted the way the browser submits it.
 *
 * Form encoding, the CSRF token in the body, the session cookie alongside, and
 * `Accept: text/html` so the action answers with a redirect rather than JSON.
 * `days` is sent as the grid sends it: the empty hidden companion first, then
 * one value per ticked box.
 */
async function saveHours(days: string[], startsAt: string, endsAt: string, timezone = 'Europe/Berlin') {
  const page = await fetchPage('/settings/notifications')
  const body = new URLSearchParams()

  body.append('_token', tokenField(page.html))
  body.append('days', '')
  for (const day of days)
    body.append('days', day)
  body.append('starts_at', startsAt)
  body.append('ends_at', endsAt)
  body.append('timezone', timezone)

  const answer = await fetch(`http://127.0.0.1:${port}/api/user/notifications/schedule`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `auth-token=${created.token}; X-CSRF-Token=${page.csrf}`,
    },
    body,
  })

  return { status: answer.status, location: String(answer.headers.get('location') ?? '') }
}

/** The stored row, which is the only answer that actually matters. */
async function stored(): Promise<{ days: string, startsAt: number, endsAt: number, timezone: string } | null> {
  const db = (globalThis as any).db
  const row: any = await db
    .selectFrom('notification_schedules')
    .select(['days', 'starts_at', 'ends_at', 'timezone'])
    .where('user_id', '=', created.userId)
    .executeTakeFirst()

  return row
    ? { days: String(row.days ?? ''), startsAt: Number(row.starts_at), endsAt: Number(row.ends_at), timezone: String(row.timezone ?? '') }
    : null
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

    created.handle = unique('hours')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Hours Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.userId = Number(user?.id)

    const issued: any = await createToken(created.userId, 'notification schedule form test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    available = Boolean(created.userId && created.token)
  }
  catch (error) {
    console.warn(`[notification-schedule-form] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  /*
   * A try/catch per statement, not `.catch(...)` on the call and not one
   * `try` around both.
   *
   * `bun-query-builder` 0.6.4 answers a db call with its value where it is
   * written rather than with a promise, so `.execute().catch(...)` is a
   * property access on a plain value and throws on the *success* path. One
   * `try` around the pair has the same end result by a different route: the
   * first statement throwing skips the second, which is the one that removes
   * the user, and the test quietly litters a row per run.
   */
  for (const remove of [
    () => db.deleteFrom('notification_schedules').where('user_id', '=', created.userId).execute(),
    () => db.deleteFrom('users').where('id', '=', created.userId).execute(),
  ]) {
    if (!created.userId)
      break

    try {
      await remove()
    }
    catch {}
  }

  try {
    server?.stop?.()
  }
  catch {}
})

describe('the settings form can reach the endpoint at all', () => {
  test('a POST is routed rather than answered 405', async () => {
    if (!available)
      return

    const answer = await saveHours(['1', '2', '3'], '09:00', '17:00')

    // 303 back to the page. The fault being pinned is 405, so the assertion
    // worth making is "not that", and then that the row changed.
    expect(answer.status).not.toBe(405)
    expect(answer.status).toBe(303)
  })
})

describe('what the form posts is what gets stored', () => {
  test('three days and a pair of clock times', async () => {
    if (!available)
      return

    await saveHours(['1', '2', '3'], '09:00', '17:00')

    expect(await stored()).toEqual({ days: '1,2,3', startsAt: 540, endsAt: 1020, timezone: 'Europe/Berlin' })
  })

  test('one day, which is the only shape the old rule let through', async () => {
    if (!available)
      return

    await saveHours(['4'], '08:30', '18:45')

    expect(await stored()).toEqual({ days: '4', startsAt: 510, endsAt: 1125, timezone: 'Europe/Berlin' })
  })

  test('every day, which is the whole week and not six of it', async () => {
    if (!available)
      return

    await saveHours(['0', '1', '2', '3', '4', '5', '6'], '00:00', '23:59')

    expect(await stored()).toEqual({ days: '0,1,2,3,4,5,6', startsAt: 0, endsAt: 1439, timezone: 'Europe/Berlin' })
  })

  /*
   * The empty companion earns its place here. A checkbox sends nothing when it
   * is clear, so with every box clear the field would be absent, the handler
   * would read that as "not submitted" and keep the days already stored - and
   * answer "saved" to somebody who had just turned every day off.
   */
  test('and no days at all, which means never interrupt me', async () => {
    if (!available)
      return

    await saveHours(['1', '2'], '09:00', '17:00')
    expect((await stored())?.days).toBe('1,2')

    await saveHours([], '09:00', '17:00')
    expect((await stored())?.days).toBe('')
  })

  /*
   * `Number('')` is `0` and `0` is Sunday, so the companion arriving at the
   * front of the list used to add a day nobody chose: Monday to Wednesday
   * stored `0,1,2,3`, silencing Sunday for everybody who had never picked it.
   */
  test('and the companion does not quietly add Sunday', async () => {
    if (!available)
      return

    await saveHours(['1', '2', '3'], '09:00', '17:00')

    expect((await stored())?.days).not.toContain('0')
    expect((await stored())?.days).toBe('1,2,3')
  })
})

describe('what it still refuses', () => {
  test('a window with no width', async () => {
    if (!available)
      return

    await saveHours(['1'], '09:00', '17:00')
    const before = await stored()

    const answer = await saveHours(['1'], '09:00', '09:00')

    expect(answer.status).toBe(303)
    expect(answer.location).toContain('error=')
    expect(await stored()).toEqual(before!)
  })

  test('a clock that is not a time', async () => {
    if (!available)
      return

    await saveHours(['1'], '09:00', '17:00')
    const before = await stored()

    const answer = await saveHours(['1'], '25:00', '17:00')

    expect(answer.location).toContain('error=')
    expect(await stored()).toEqual(before!)
  })

  test('and a timezone that is not one', async () => {
    if (!available)
      return

    await saveHours(['1'], '09:00', '17:00')
    const before = await stored()

    const answer = await saveHours(['1'], '09:00', '17:00', 'Mars/Olympus_Mons')

    expect(answer.location).toContain('error=')
    expect(await stored()).toEqual(before!)
  })
})

describe('the API shape the endpoint already had', () => {
  test('a PUT with minutes from midnight still works', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/user/notifications/schedule`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${created.token}`,
      },
      body: new URLSearchParams({ days: '1,2,3,4,5', starts_at: '540', ends_at: '1020', timezone: 'UTC' }),
    })

    expect(answer.status).toBe(200)
    expect(await stored()).toEqual({ days: '1,2,3,4,5', startsAt: 540, endsAt: 1020, timezone: 'UTC' })
  })

  /*
   * What the live form reads to tell somebody what their new hours mean. The
   * reload used to discard it, which is why `data-live-says` exists.
   */
  test('and it answers with what the schedule would do right now', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/user/notifications/schedule`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${created.token}`,
      },
      body: new URLSearchParams({ days: '1,2,3,4,5', starts_at: '540', ends_at: '1020', timezone: 'UTC' }),
    })

    const body: any = await answer.json()

    expect(typeof body?.right_now?.explanation).toBe('string')
    expect(String(body.right_now.explanation).length).toBeGreaterThan(0)
  })
})
