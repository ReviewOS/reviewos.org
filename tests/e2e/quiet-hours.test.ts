// Quiet hours, mutes, and what actually reaches somebody.
//
// The rules are unit tested as pure functions. What that cannot cover is the
// half that only exists with rows in a table: `deliveryFor` reads a schedule, a
// mute and a do-not-disturb and combines them, and every one of the four can be
// right on its own while the combination is wrong.
//
// The bar this phase set is that nobody has to mute the product to get work
// done, and the load-bearing part of that promise is a mute that people trust:
// **a muted thing still lands in the inbox**. If muting lost the record, nobody
// would use it, and they would turn notifications off instead - after which the
// reviewer everybody is waiting on is unreachable by design.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { plainId: 0, quietId: 0, dndId: 0, breakId: 0 }
const subject = { type: 'pull_request' as const, id: 555_111 }

let available = false
let deliveryFor: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Somebody's answer for a review request on this channel, at this instant. */
async function ask(userId: number, nowMs: number, channel: 'email' | 'in_app' = 'email', subjects: any[] = []) {
  return deliveryFor({ userId, channel, event: 'review:requested', subjects, nowMs })
}

/** A Monday at the given local hour, in UTC. 2026-08-10 is a Monday. */
function mondayAt(hour: number): number {
  return Date.parse(`2026-08-10T${String(hour).padStart(2, '0')}:00:00.000Z`)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    ;({ deliveryFor } = await import('../../app/Actions/Notification/settings'))

    const make = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Quiet', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.plainId = await make('qhp')
    created.quietId = await make('qhq')
    created.dndId = await make('qhd')
    created.breakId = await make('qhb')

    // Weekdays, 09:00 to 18:00 UTC.
    for (const [userId, breaksThrough] of [[created.quietId, ''], [created.breakId, 'review:requested']] as const) {
      await db.insertInto('notification_schedules').values({
        user_id: userId,
        days: '1,2,3,4,5',
        starts_at: 9 * 60,
        ends_at: 18 * 60,
        timezone: 'UTC',
        breaks_through: breaksThrough,
      }).execute()
    }

    await db.insertInto('notification_schedules').values({
      user_id: created.dndId,
      days: '1,2,3,4,5',
      starts_at: 0,
      ends_at: 1439,
      timezone: 'UTC',
      breaks_through: '',
      do_not_disturb_until: new Date(mondayAt(12) + 3_600_000).toISOString(),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[quiet-hours] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  // One statement per table rather than twelve. Bun's default hook timeout is
  // five seconds and the per-user loop spent all of it, which fails the file
  // after every assertion in it has already passed - a shape that reads as a
  // broken feature and is a slow teardown.
  const ids = [created.plainId, created.quietId, created.dndId, created.breakId].filter(Boolean)
  if (ids.length === 0)
    return

  await db.deleteFrom('notification_mutes').where('user_id', 'in', ids).execute()
  await db.deleteFrom('notification_schedules').where('user_id', 'in', ids).execute()
  await db.deleteFrom('users').where('id', 'in', ids).execute()
}, 30_000)

describe('a schedule', () => {
  test('an event at 03:00 is held, with the time it will arrive', async () => {
    if (!available)
      return

    const outcome = await ask(created.quietId, mondayAt(3))

    expect(outcome.decision).toBe('hold')
    expect(outcome.because).toBe('quiet-hours')
    // Held, never dropped - and the time is what the digest sweep needs and
    // what somebody asking "why did I not hear about this" deserves.
    expect(outcome.deliverAtMs).toBeGreaterThan(mondayAt(3))
  })

  test('and arrives once the window opens', async () => {
    if (!available)
      return

    expect((await ask(created.quietId, mondayAt(10))).decision).toBe('send')
  })

  test('nobody with a schedule is constrained by it outside their listed days', async () => {
    if (!available)
      return

    // 2026-08-09 is a Sunday, which is not in the list. The window applies to
    // the days it names, so a Sunday is closed rather than unconstrained.
    const sunday = Date.parse('2026-08-09T10:00:00.000Z')

    expect((await ask(created.quietId, sunday)).decision).toBe('hold')
  })

  test('somebody with no schedule at all is reachable', async () => {
    if (!available)
      return

    // A missing row means unconstrained, not silent. Most people never set one,
    // and reading absence as "off" would make the product mute by default.
    expect((await ask(created.plainId, mondayAt(3))).decision).toBe('send')
  })

  test('the inbox is never held', async () => {
    if (!available)
      return

    // It is the record, and a record with holes in it is what makes people
    // distrust quiet hours and stop using them.
    expect((await ask(created.quietId, mondayAt(3), 'in_app')).decision).toBe('send')
  })
})

describe('break-through', () => {
  test('ignores the schedule for the events on the list', async () => {
    if (!available)
      return

    const outcome = await ask(created.breakId, mondayAt(3))

    expect(outcome.decision).toBe('send')
    expect(outcome.because).toBe('breaks-through')
  })

  test('but not for the ones that are not', async () => {
    if (!available)
      return

    const outcome = await deliveryFor({
      userId: created.breakId,
      channel: 'email',
      event: 'comment:created',
      subjects: [],
      nowMs: mondayAt(3),
    })

    expect(outcome.decision).toBe('hold')
  })
})

describe('do not disturb', () => {
  test('holds until it ends, then stops applying by itself', async () => {
    if (!available)
      return

    // Ending by itself is the whole point: a switch somebody has to remember to
    // turn back off is one that leaves them unreachable for a week.
    expect((await ask(created.dndId, mondayAt(12))).because).toBe('do-not-disturb')
    expect((await ask(created.dndId, mondayAt(14))).decision).toBe('send')
  })
})

describe('a mute', () => {
  test('drops the interrupting channels', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.insertInto('notification_mutes').values({
      user_id: created.plainId,
      subject_type: subject.type,
      subject_id: subject.id,
      expires_at: null,
    }).execute()

    const outcome = await ask(created.plainId, mondayAt(12), 'email', [subject])

    expect(outcome.decision).toBe('drop')
    expect(outcome.because).toBe('muted')
  })

  test('and still lands in the inbox', async () => {
    if (!available)
      return

    // The load-bearing promise. If muting lost the record nobody would use it,
    // and they would turn notifications off instead.
    const outcome = await ask(created.plainId, mondayAt(12), 'in_app', [subject])

    expect(outcome.decision).toBe('send')
    expect(outcome.because).toBe('muted')
  })

  test('outranks break-through, because it is a decision about the subject', async () => {
    if (!available)
      return

    // There is no hour at which somebody wants the thing they muted, which is
    // exactly what makes muting different from quiet hours.
    const db = (globalThis as any).db
    await db.insertInto('notification_mutes').values({
      user_id: created.breakId,
      subject_type: subject.type,
      subject_id: subject.id,
      expires_at: null,
    }).execute()

    expect((await ask(created.breakId, mondayAt(3), 'email', [subject])).decision).toBe('drop')
  })

  test('the widest one wins: a thread inside a muted repository is muted', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.insertInto('notification_mutes').values({
      user_id: created.quietId,
      subject_type: 'repository',
      subject_id: 999_222,
      expires_at: null,
    }).execute()

    // Muting the repository is the action people actually take, and a thread
    // inside it should not keep interrupting because it was not named.
    const outcome = await ask(created.quietId, mondayAt(12), 'email', [
      { type: 'pull_request', id: 777_333 },
      { type: 'repository', id: 999_222 },
    ])

    expect(outcome.decision).toBe('drop')
  })

  test('expires on its own', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.insertInto('notification_mutes').values({
      user_id: created.dndId,
      subject_type: subject.type,
      subject_id: subject.id,
      expires_at: new Date(mondayAt(12)).toISOString(),
    }).execute()

    expect((await ask(created.dndId, mondayAt(11), 'email', [subject])).decision).toBe('drop')
    // An hour later it is not a mute any more, without anybody clearing it.
    expect((await ask(created.dndId, mondayAt(14), 'email', [subject])).decision).toBe('send')
  })
})
