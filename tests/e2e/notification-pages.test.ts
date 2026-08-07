// The inbox and the notification settings page, through the real routes.
//
// Both render entirely on the server, and stx fails silently: a server script
// that throws renders its page with every variable undefined and says nothing,
// so the inbox would show its empty state to somebody with forty notifications
// and the settings grid would come out blank. Neither failure looks like a
// failure - they look like "nothing happened yet".
//
// So this asks the pages, not the functions, and asserts on content that can
// only be there if the script ran: a notification's own title, and a select
// carrying the value the database holds.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. It needs no git.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { readerId: 0, token: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, cookieToken?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
  })

  return await answer.text()
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

    const { createToken } = await import('@stacksjs/auth')
    const handle = unique('npg')

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Page Reader', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.readerId = Number(row?.id)

    const issued: any = await createToken(created.readerId, 'notification pages test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    await db.insertInto('notifications').values({
      user_id: created.readerId,
      type: 'review.requested',
      data: JSON.stringify({
        title: 'a-very-distinctive-notification-title',
        url: '/acme/api/pull/12/files',
        reason: 'review_requested',
        repository: 'acme/api',
        number: 12,
      }),
    }).execute()

    // A chosen preference, so the settings page has something to render that a
    // blank page could not fake.
    await db.insertInto('notification_event_preferences').values({
      user_id: created.readerId,
      event: 'comment:created',
      channel: 'email',
      delivery: 'off',
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[notification-pages] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.readerId) {
      await db.deleteFrom('notifications').where('user_id', '=', created.readerId).execute()
      await db.deleteFrom('notification_event_preferences').where('user_id', '=', created.readerId).execute()
      await db.deleteFrom('users').where('id', '=', created.readerId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
})

describe('the inbox page', () => {
  test('renders the notification, with the reason it arrived', async () => {
    if (!available)
      return

    const html = await fetchPage('/notifications', created.token)

    expect(html).toContain('a-very-distinctive-notification-title')
    // The reason is the difference between an inbox people read and one they
    // mute. Its absence is the tell that the script ran but the shaping did not.
    expect(html).toContain('your review was requested')
    expect(html).toContain('/acme/api/pull/12/files')
  })

  test('offers the repository as a filter', async () => {
    if (!available)
      return

    const html = await fetchPage('/notifications', created.token)

    expect(html).toContain('repository=acme%2Fapi')
  })

  test('a signed-out reader is asked to sign in rather than shown an empty inbox', async () => {
    if (!available)
      return

    // The two look identical if the server script threw, which is exactly the
    // stx failure mode this file exists for.
    const html = await fetchPage('/notifications')

    expect(html).toContain('Sign in')
    expect(html).not.toContain('a-very-distinctive-notification-title')
  })

  test('the badge is on the navigation for a reader with unread', async () => {
    if (!available)
      return

    const html = await fetchPage('/notifications', created.token)

    expect(html).toContain('unread notifications')
  })
})

describe('the notification settings page', () => {
  test('renders every event, in words rather than wire names', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/notifications', created.token)

    expect(html).toContain('Somebody asks for your review')
    expect(html).toContain('A release is published')
  })

  test('shows the stored choice as selected', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/notifications', created.token)
    const row = html.slice(html.indexOf('comment:created'))

    expect(row).toContain('value="off" selected')
  })

  test('marks the cells nobody has chosen as defaults', async () => {
    if (!available)
      return

    // A settings screen that cannot distinguish "I picked this" from "nobody
    // touched it" is one where changing a shipped default changes nothing for
    // anybody who ever pressed a button.
    const html = await fetchPage('/settings/notifications', created.token)

    expect(html).toContain('default')
  })

  test('the inbox column is a word, not a control', async () => {
    if (!available)
      return

    // A disabled select that can never change is furniture people try to click.
    const html = await fetchPage('/settings/notifications', created.token)

    expect(html).toContain('Inbox: immediate')
  })

  test('a signed-out reader is asked to sign in', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/notifications')

    expect(html).toContain('Sign in')
    expect(html).not.toContain('Somebody asks for your review')
  })
})
