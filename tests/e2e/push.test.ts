// Web push: subscribing, sending, and forgetting the browsers that are gone.
//
// The protocol itself is tested in `@stacksjs/push` against RFC 8291's own
// vector. What that cannot cover is the part this application owns, and every
// one of these fails silently:
//
//   - A subscription that returns 410 must be **pruned**. Keeping it means
//     every future notification spends a request on a browser that no longer
//     exists, forever, and the delivery log fills with failures nobody can act
//     on. Pruning on anything else would sign somebody out of push because a
//     push service had a bad afternoon.
//   - A held notification must not push. A push that ignores quiet hours is
//     worse than no push: it is the exact thing people mute the product over.
//   - The payload must carry **nothing private**. It lands on a device that may
//     be locked on a desk or mirrored to a watch, and a notification preview is
//     shown before anybody authenticates.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, quietId: 0 }

let available = false
let service: any = null
let servicePort = 0
let answers = new Map<string, number>()
let bodies: Array<{ path: string, headers: Record<string, string>, bytes: number }> = []

/** A real P-256 public key, so the encryption has something valid to work against. */
let subscriberKeys: { p256dh: string, auth: string }

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function subscriptionsFor(userId: number): Promise<any[]> {
  return (globalThis as any).db
    .selectFrom('push_subscriptions')
    .select(['id', 'endpoint'])
    .where('user_id', '=', userId)
    .execute()
}

/** Register a browser whose endpoint answers with `status`. */
async function register(userId: number, status: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${servicePort}/${status}/${unique('ep')}`
  answers.set(new URL(endpoint).pathname, status)

  await (globalThis as any).db.insertInto('push_subscriptions').values({
    user_id: userId,
    endpoint,
    public_key: subscriberKeys.p256dh,
    auth_secret: subscriberKeys.auth,
    user_agent: 'Mozilla/5.0 (Macintosh) Chrome/120',
    last_seen_at: new Date().toISOString(),
  }).execute()

  return endpoint
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    // Keys the browser would have generated. A real pair, because the driver
    // does a real ECDH against them and a placeholder throws.
    const { createECDH, randomBytes } = await import('node:crypto')
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()

    subscriberKeys = {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    }

    // This instance needs keys for any of it to run. Generated per test rather
    // than read from .env: a suite that only passes on a configured machine is
    // one that passes on nobody else's.
    const { generateVapidKeys } = await import('@stacksjs/push')
    const vapid = generateVapidKeys()
    Bun.env.VAPID_PUBLIC_KEY = vapid.publicKey
    Bun.env.VAPID_PRIVATE_KEY = vapid.privateKey
    Bun.env.VAPID_SUBJECT = 'mailto:ops@example.com'

    service = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url)
        const status = answers.get(url.pathname) ?? 201

        bodies.push({
          path: url.pathname,
          headers: Object.fromEntries(request.headers.entries()),
          bytes: (await request.arrayBuffer()).byteLength,
        })

        return new Response(null, { status })
      },
    })

    servicePort = Number(service.port)

    const make = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Push', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.userId = await make('psh')
    created.quietId = await make('psq')

    // Shut for the next day, whatever "now" is.
    await db.insertInto('notification_schedules').values({
      user_id: created.quietId,
      days: '1,2,3,4,5',
      starts_at: 540,
      ends_at: 1080,
      timezone: 'UTC',
      breaks_through: '',
      do_not_disturb_until: new Date(Date.now() + 86_400_000).toISOString(),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[push] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    const ids = [created.userId, created.quietId].filter(Boolean)

    if (db && ids.length > 0) {
      await db.deleteFrom('notification_event_preferences').where('user_id', 'in', ids).execute()
      await db.deleteFrom('push_subscriptions').where('user_id', 'in', ids).execute()
      await db.deleteFrom('notification_deliveries').where('user_id', 'in', ids).execute()
      await db.deleteFrom('notification_schedules').where('user_id', 'in', ids).execute()
      await db.deleteFrom('users').where('id', 'in', ids).execute()
    }
  }
  finally {
    service?.stop?.()
  }
}, 30_000)

describe('sending to a browser', () => {
  test('rings it, and says how many', async () => {
    if (!available)
      return

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    await register(created.userId, 201)
    bodies = []

    const outcome = await pushToUser(created.userId, { title: 'chris approved it', url: '/acme/api/pull/12' })

    expect(outcome.sent).toBe(1)
    expect(outcome.pruned).toBe(0)
    expect(bodies).toHaveLength(1)
  })

  test('the body is encrypted, not the notification in the clear', async () => {
    if (!available)
      return

    // The push service forwards this and cannot open it. A driver that shipped
    // the payload in the clear would work perfectly and leak every
    // notification through a third party.
    const last = bodies[bodies.length - 1]

    expect(last.headers['content-encoding']).toBe('aes128gcm')
    expect(last.bytes).toBeGreaterThan(90)
  })

  test('carries a collapse topic, so three about one thread become one', async () => {
    if (!available)
      return

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    bodies = []

    await pushToUser(created.userId, {
      title: 'chris commented',
      url: '/acme/api/pull/12',
      tag: 'pull_request:4821',
    })

    const topic = bodies[bodies.length - 1].headers.topic

    // base64url, at most 32 characters. A raw tag like `pull_request:4821` is
    // neither, and a push service answers the whole request with a 400 rather
    // than ignoring the header - so an unencoded tag stops the notification
    // entirely rather than degrading to "no collapsing".
    expect(topic).toBeTruthy()
    expect(topic.length).toBeLessThanOrEqual(32)
    expect(/^[\w-]+$/.test(topic)).toBe(true)
  })

  test('an instance with no keys says so rather than failing', async () => {
    if (!available)
      return

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    const previous = Bun.env.VAPID_PRIVATE_KEY
    Bun.env.VAPID_PRIVATE_KEY = ''

    try {
      // Not a failure: an instance that never configured push should send email
      // and fill the inbox exactly as before.
      expect((await pushToUser(created.userId, { title: 'x', url: '/' })).unconfigured).toBe(true)
    }
    finally {
      Bun.env.VAPID_PRIVATE_KEY = previous
    }
  })
})

describe('pruning', () => {
  test('a subscription that answers 410 is deleted', async () => {
    if (!available)
      return

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    const db = (globalThis as any).db
    await db.deleteFrom('push_subscriptions').where('user_id', '=', created.userId).execute()

    await register(created.userId, 410)

    const outcome = await pushToUser(created.userId, { title: 'x', url: '/' })

    expect(outcome.pruned).toBe(1)
    expect(await subscriptionsFor(created.userId)).toHaveLength(0)
  })

  test('and so is one that answers 404', async () => {
    if (!available)
      return

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    await register(created.userId, 404)

    expect((await pushToUser(created.userId, { title: 'x', url: '/' })).pruned).toBe(1)
    expect(await subscriptionsFor(created.userId)).toHaveLength(0)
  })

  test('a 429 is kept, because it is not gone', async () => {
    if (!available)
      return

    // Deleting on this would sign somebody out of push because a push service
    // was rate limiting for a minute.
    const { pushToUser } = await import('../../app/Actions/Notification/push')
    await register(created.userId, 429)

    const outcome = await pushToUser(created.userId, { title: 'x', url: '/' })

    expect(outcome.pruned).toBe(0)
    expect(outcome.failed).toBe(1)
    expect(await subscriptionsFor(created.userId)).toHaveLength(1)
  })

  test('a 500 is kept too', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('push_subscriptions').where('user_id', '=', created.userId).execute()

    const { pushToUser } = await import('../../app/Actions/Notification/push')
    await register(created.userId, 500)

    expect((await pushToUser(created.userId, { title: 'x', url: '/' })).pruned).toBe(0)
    expect(await subscriptionsFor(created.userId)).toHaveLength(1)
  })
})

describe('the same rules as every other channel', () => {
  test('a held notification does not push', async () => {
    if (!available)
      return

    // A push that ignores quiet hours is worse than no push: it is the exact
    // thing people mute the product over. The decision is made in the job, so
    // this asks the job rather than the sender.
    const job = (await import('../../app/Jobs/SendNotificationJob')).default
    await register(created.quietId, 201)

    // Opted in first. Push defaults to `off`, and the preference is checked
    // before the schedule - correctly, since there is no point asking what time
    // it is for a channel somebody never turned on. Without this the test would
    // pass on the wrong rule and prove nothing about quiet hours.
    await (globalThis as any).db.insertInto('notification_event_preferences').values({
      user_id: created.quietId,
      event: 'review:requested',
      channel: 'push',
      delivery: 'immediate',
    }).execute()

    bodies = []

    const result: any = await (job as any).handle({
      userId: created.quietId,
      event: 'review:requested',
      channel: 'push',
      title: 'chris requested your review',
      url: '/acme/api/pull/12/files',
      subjects: [{ type: 'pull_request', id: 4821 }],
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('do-not-disturb')
    expect(bodies).toHaveLength(0)
  })

  test('and the hold is recorded, so somebody can ask why', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('notification_deliveries')
      .select(['channel', 'status', 'error'])
      .where('user_id', '=', created.quietId)
      .execute()

    expect(rows[rows.length - 1]).toMatchObject({ channel: 'push', status: 'pending' })
  })
})

describe('what the payload may contain', () => {
  test('the sentence and a path, and nothing else', async () => {
    if (!available)
      return

    // It lands on a device that may be locked on a desk or mirrored to a
    // watch, and the preview is shown before anybody authenticates. So it
    // carries no diff, no comment body, and no private file name - only what
    // the recipient could already read.
    const source = await Bun.file('app/Actions/Notification/push.ts').text()
    const payload = source.slice(source.indexOf('const payload = JSON.stringify('), source.indexOf('const outcome: PushOutcome'))

    for (const field of ['title:', 'body:', 'url:', 'tag:'])
      expect(payload).toContain(field)

    // The fields a well-meaning change would add. Each one is content the
    // recipient may be able to read in the product and still should not have
    // on a lock screen.
    for (const leak of ['diff', 'patch', 'comment', 'secret', 'token'])
      expect(payload.toLowerCase()).not.toContain(leak)
  })
})
