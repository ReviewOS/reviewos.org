// The delivery job, against a real table.
//
// The preference rules are unit tested against literals. What that cannot cover
// is the half the job exists for: that a decision is made when the job runs
// rather than when it was queued, and that every outcome is written down -
// including the ones that did not send.
//
// That last part is the one worth a database test. A log that records only
// successes cannot answer "why did I not hear about this", which is the
// question somebody actually asks, and the absence of a row is
// indistinguishable from a worker that never ran.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0 }

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Run the job directly: the queue is not what these tests are about. */
async function run(overrides: Record<string, unknown> = {}): Promise<any> {
  const job = (await import('../../app/Jobs/SendNotificationJob')).default

  return (job as any).handle({
    userId: created.userId,
    event: 'review:requested',
    channel: 'email',
    title: 'chris requested your review',
    url: '/acme/api/pull/12/files',
    subjects: [{ type: 'pull_request', id: 4242 }],
    ...overrides,
  })
}

/** Everything written about this recipient, newest last. */
async function deliveries(): Promise<any[]> {
  return (globalThis as any).db
    .selectFrom('notification_deliveries')
    .select(['channel', 'status', 'error', 'subject'])
    .where('user_id', '=', created.userId)
    .orderBy('id', 'asc')
    .execute()
}

async function prefer(event: string, channel: string, delivery: string): Promise<void> {
  await (globalThis as any).db.insertInto('notification_event_preferences').values({
    user_id: created.userId,
    event,
    channel,
    delivery,
  }).execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const handle = unique('snj')
    const row: any = await db
      .insertInto('users')
      .values({ name: 'Recipient', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)
    available = true
  }
  catch (error) {
    console.warn(`[send-notification] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db || !created.userId)
    return

  await db.deleteFrom('notification_deliveries').where('user_id', '=', created.userId).execute()
  await db.deleteFrom('notification_event_preferences').where('user_id', '=', created.userId).execute()
  await db.deleteFrom('users').where('id', '=', created.userId).execute()
})

describe('what the job refuses to do', () => {
  test('the inbox is not its business', async () => {
    if (!available)
      return

    // The listener writes that inline, because it is the channel that has to
    // work when nothing else does. A job that also wrote it would double it.
    expect((await run({ channel: 'in_app' })).reason).toBe('not a deferrable channel')
  })

  test('a deleted account is a no-op, not three retries', async () => {
    if (!available)
      return

    const result = await run({ userId: -1 })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('recipient no longer exists')
  })
})

describe('preferences decide, and the decision is recorded', () => {
  test('off is skipped, and says so', async () => {
    if (!available)
      return

    await prefer('review:requested', 'email', 'off')

    const result = await run()

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('off')

    const rows = await deliveries()
    const last = rows[rows.length - 1]

    // Not `failed`: a deliberate choice does not belong in the same column as
    // a refused mail server.
    expect(last.status).toBe('skipped')
    expect(last.error).toContain('turned this channel off')
  })

  test('digest is held for the sweep rather than sent now', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('notification_event_preferences').where('user_id', '=', created.userId).execute()
    await prefer('review:requested', 'email', 'digest')

    const result = await run()

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('digest')

    const rows = await deliveries()

    // Sending it now would make "digest" mean "immediate with extra steps",
    // which is exactly the setting people stop trusting.
    expect(rows[rows.length - 1].status).toBe('pending')
  })

  test('push is not wired up, and the log says that rather than claiming a send', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('notification_event_preferences').where('user_id', '=', created.userId).execute()
    await prefer('review:requested', 'push', 'immediate')

    // A channel that silently succeeds is worse than one that visibly does not
    // exist: the log would fill with rows claiming somebody was reached.
    await expect(run({ channel: 'push' })).rejects.toThrow(/not wired up/)

    const rows = await deliveries()

    expect(rows[rows.length - 1].status).toBe('failed')
  })

  test('the default applies when nobody chose', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('notification_event_preferences').where('user_id', '=', created.userId).execute()

    // `comment:created` defaults to digest on email: watching a busy repository
    // must not be indistinguishable from a mailing list.
    const result = await run({ event: 'comment:created' })

    expect(result.reason).toBe('digest')
  })
})
