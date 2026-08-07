// Unsubscribing from a link in an email, with no session.
//
// The whole feature is a security boundary made of one token, so the cases
// worth a real HTTP test are the ones where getting it wrong is silent:
//
//   - GET must change nothing. Mail security scanners fetch every URL in a
//     message before a human sees it, so a link that acted on being opened
//     would unsubscribe people who never read the email - and they would never
//     learn why the notifications stopped.
//   - The scope must be unforgeable. It is inside the signed payload precisely
//     so a link cannot be edited from "this pull request" into "everything".
//   - An address with no account must be answered the same as one with, or the
//     endpoint becomes a way to test whether somebody has an account here.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, email: '', subjectId: 987_654 }

let available = false
let port = 0
let server: any = null
let mint: (email: string, ttl?: number, scope?: string) => string

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function call(method: string, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Accept: 'application/json' } })
}

async function subscriptionState(): Promise<boolean | null> {
  const row: any = await (globalThis as any).db
    .selectFrom('notification_subscriptions')
    .select(['unsubscribed'])
    .where('user_id', '=', created.userId)
    .where('subject_type', '=', 'pull_request')
    .where('subject_id', '=', created.subjectId)
    .executeTakeFirst()

  return row ? Boolean(row.unsubscribed) : null
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

    ;({ createUnsubscribeToken: mint } = await import('@stacksjs/email') as any)

    const handle = unique('uns')
    created.email = `${handle}@example.com`

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Unsub', email: created.email, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    await db.insertInto('notification_subscriptions').values({
      user_id: created.userId,
      subject_type: 'pull_request',
      subject_id: created.subjectId,
      reason: 'watching',
      unsubscribed: false,
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[unsubscribe] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('notification_subscriptions').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
})

describe('opening the link', () => {
  test('changes nothing, because scanners open it before people do', async () => {
    if (!available)
      return

    const token = mint(created.email, 3600, `pull_request:${created.subjectId}`)

    await fetch(`http://127.0.0.1:${port}/unsubscribe/${token}`, { headers: { Accept: 'text/html' } })

    expect(await subscriptionState()).toBe(false)
  })

  test('the page says what will stop, in words rather than a type name', async () => {
    if (!available)
      return

    const token = mint(created.email, 3600, `pull_request:${created.subjectId}`)
    const html = await (await fetch(`http://127.0.0.1:${port}/unsubscribe/${token}`, {
      headers: { Accept: 'text/html' },
    })).text()

    expect(html).toContain('this pull request')
    expect(html).not.toContain('pull_request:')
  })
})

describe('pressing the button', () => {
  test('unsubscribes from that thread', async () => {
    if (!available)
      return

    const token = mint(created.email, 3600, `pull_request:${created.subjectId}`)
    const answer = await call('POST', `/unsubscribe/${token}`)

    expect(answer.status).toBe(200)
    expect(await subscriptionState()).toBe(true)
  })

  test('the row is kept rather than deleted, so a later comment cannot resubscribe them', async () => {
    if (!available)
      return

    // The single fastest way to teach people that unsubscribing here does not
    // work would be to delete the row and let the next comment recreate it.
    expect(await subscriptionState()).toBe(true)
  })
})

describe('what the token will not let you do', () => {
  test('an edited scope is refused', async () => {
    if (!available)
      return

    // The whole reason the scope is signed rather than carried in the URL.
    const token = mint(created.email, 3600, `pull_request:${created.subjectId}`)
    const [payload, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))

    claims.scope = 'repository:1'

    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
    const answer = await call('POST', `/unsubscribe/${forged}`)

    expect(answer.status).toBe(400)
  })

  test('an expired link says so, rather than failing generically', async () => {
    if (!available)
      return

    // "This link has expired" is the difference between somebody asking for a
    // new one and somebody giving up on the product.
    const answer = await call('POST', `/unsubscribe/${mint(created.email, -1, 'pull_request:1')}`)

    expect(answer.status).toBe(410)
  })

  test('a token with no scope is refused rather than read as everything', async () => {
    if (!available)
      return

    // Falling back to something broader would turn a malformed link into a
    // silent global opt-out.
    const answer = await call('POST', `/unsubscribe/${mint(created.email, 3600)}`)

    expect(answer.status).toBe(400)
  })

  test('an address with no account is answered the same as one with', async () => {
    if (!available)
      return

    // Otherwise this endpoint is a way to test whether somebody has an account
    // here, and there is nothing to unsubscribe anyway.
    const answer = await call('POST', `/unsubscribe/${mint('nobody@example.com', 3600, 'pull_request:1')}`)

    expect(answer.status).toBe(200)
  })

  test('nonsense is refused without a stack trace', async () => {
    if (!available)
      return

    expect((await call('POST', '/unsubscribe/not-a-token')).status).toBe(400)
  })
})
