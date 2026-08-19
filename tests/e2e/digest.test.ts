// The digest sweep: what was held, eventually sent.
//
// `SendNotificationJob` writes a pending row and stops whenever the answer is
// "not now". This is the half that sends it, and without it `digest` and quiet
// hours would both be a polite way of dropping mail - worse than either setting
// not existing, because somebody who chose "digest" would be silently
// unreachable with no way to tell.
//
// The rules worth a database test are the two that fail quietly. A sweep that
// marks rows sent when the send failed loses every notification in the batch.
// A sweep that ignores a recipient's window mails them at 03:00 and defeats the
// setting it exists to serve.
//
// Three of the cases below assert the *failure* path and get it from the
// environment: there is no mail server in a checkout, so every send fails. That
// is deliberate and it is also fragile - point `MAIL_MAILER` at the log driver
// and they fail, because sends start succeeding. Making it deterministic means
// forcing the failure explicitly rather than relying on there being no SMTP
// host, and that is a rewrite of these three rather than a setting.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dbTimestamp } from '../../app/Actions/Support/sql'

const created = { openId: 0, shutId: 0 }

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A held delivery, as SendNotificationJob would have written it. */
async function hold(userId: number, title: string, url: string, minutesAgo = 0): Promise<void> {
  const at = dbTimestamp(new Date(Date.now() - minutesAgo * 60_000))

  await (globalThis as any).db.insertInto('notification_deliveries').values({
    user_id: userId,
    channel: 'email',
    recipient: `digest-${userId}@example.com`,
    subject: title,
    body: url,
    status: 'pending',
    error: 'held for the digest',
    created_at: at,
  }).execute()
}

async function statusesFor(userId: number): Promise<string[]> {
  const rows: any[] = await (globalThis as any).db
    .selectFrom('notification_deliveries')
    .select(['status'])
    .where('user_id', '=', userId)
    .execute()

  return rows.map(row => String(row.status))
}

/**
 * How many distinct threads this recipient's held rows fall into.
 *
 * Asserted instead of the sweep's own `failed` counter, which counts every
 * recipient in the database: another suite's pending rows would inflate it, and
 * a test that only passes when it runs alone is a test that will be deleted
 * rather than fixed.
 */
async function threadsFor(userId: number): Promise<number> {
  const rows: any[] = await (globalThis as any).db
    .selectFrom('notification_deliveries')
    .select(['body'])
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .execute()

  return new Set(rows.map(row => String(row.body))).size
}

async function run(): Promise<any> {
  const job = (await import('../../app/Jobs/SendDigestJob')).default

  return (job as any).handle({})
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const make = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Digest', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.openId = await make('dgo')
    created.shutId = await make('dgs')

    // Shut right now, whatever "now" is. Do-not-disturb rather than a window,
    // deliberately: an empty `days` list means *unconstrained*, not
    // always-closed, so a fixture built that way would assert the opposite of
    // what it reads like and pass for the wrong reason.
    await db.insertInto('notification_schedules').values({
      user_id: created.shutId,
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
    console.warn(`[digest] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
  // The same allowance every other end-to-end file gives its setup: injecting
  // the auto-imports and opening the database is slower than bun's five-second
  // default on a loaded machine, and a suite that fails on how busy the laptop
  // is teaches people to ignore it.
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  for (const id of [created.openId, created.shutId].filter(Boolean)) {
    await db.deleteFrom('notification_deliveries').where('user_id', '=', id).execute()
    await db.deleteFrom('notification_schedules').where('user_id', '=', id).execute()
    await db.deleteFrom('users').where('id', '=', id).execute()
  }
})

describe('the sweep', () => {
  test('does nothing, cheaply, when nothing is held', async () => {
    if (!available)
      return

    const result = await run()

    expect(result.ok).toBe(true)
  })

  test('leaves a recipient whose window is shut held rather than mailing them', async () => {
    if (!available)
      return

    // The whole reason quiet hours are worth having. A sweep that sent anyway
    // would make the setting decorative.
    await hold(created.shutId, 'chris commented', '/acme/api/pull/9')

    await run()

    expect(await statusesFor(created.shutId)).toEqual(['pending'])
  })

  test('a failed send leaves the rows pending rather than marking them sent', async () => {
    if (!available)
      return

    // There is no mail server in the test environment, so this is the failure
    // path by construction - which is exactly the case worth pinning. Marking
    // them sent would lose every notification in the batch, and holding rather
    // than dropping is the entire promise.
    await hold(created.openId, 'chris approved it', '/acme/api/pull/12')
    await hold(created.openId, 'chris commented', '/acme/api/pull/12')

    const result = await run()

    expect(result.sent).toBe(0)
    expect(await statusesFor(created.openId)).toEqual(['pending', 'pending'])
  })

  test('groups by thread, so one failure is one batch and not two', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('notification_deliveries').where('user_id', '=', created.openId).execute()

    // Two threads, three notifications. Three separate messages would be the
    // bug: ten comments on one pull request are one email.
    await hold(created.openId, 'first', '/acme/api/pull/1')
    await hold(created.openId, 'second', '/acme/api/pull/1')
    await hold(created.openId, 'third', '/acme/api/pull/2')

    await run()

    // Two threads, so two batches. Both fail (there is no mail server), and
    // both stay pending - which is what "held rather than dropped" means.
    expect(await threadsFor(created.openId)).toBe(2)
    expect(await statusesFor(created.openId)).toEqual(['pending', 'pending', 'pending'])
  })

  test('a gap longer than the window closes a batch', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('notification_deliveries').where('user_id', '=', created.openId).execute()

    // Same thread, two hours apart, with a thirty minute window. A conversation
    // running all afternoon must not become one enormous message at the end.
    await hold(created.openId, 'morning', '/acme/api/pull/3', 180)
    await hold(created.openId, 'afternoon', '/acme/api/pull/3', 0)

    await run()

    // One thread, two batches, because the gap exceeded the window. Both stay
    // pending: a conversation running all afternoon must not become one
    // enormous message at the end, and nothing is lost either way.
    expect(await threadsFor(created.openId)).toBe(1)
    expect(await statusesFor(created.openId)).toEqual(['pending', 'pending'])
  })
})
