// A domain event, through subscriptions, into somebody's inbox.
//
// The sentences are unit tested. What they cannot cover is the two rules that
// only exist once there is a database: that the person who caused something is
// never told about it, and that an explicit unsubscribe survives a later event
// on the same thread. Both are the kind of rule that looks obeyed until
// somebody is on the wrong side of it, and both fail quietly - an extra inbox
// row reads as the feature working.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  actorId: 0,
  watcherId: 0,
  quietId: 0,
  strangerId: 0,
  subjectId: 4242,
}

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Everything in this reader's inbox, newest last. */
async function inboxOf(userId: number): Promise<Array<{ type: string, data: any }>> {
  const rows: any[] = await (globalThis as any).db
    .selectFrom('notifications')
    .select(['type', 'data'])
    .where('user_id', '=', userId)
    .orderBy('id', 'asc')
    .execute()

  return rows.map(row => ({ type: String(row.type), data: JSON.parse(String(row.data ?? '{}')) }))
}

/** Run the listener directly: the event bus is not what these tests are about. */
async function fire(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  const Notify = (await import('../../app/Listeners/Notify')).default

  await Notify.handle({
    actorId: created.actorId,
    actorHandle: 'actor',
    repositoryId: 1,
    owner: 'acme',
    repository: 'forge',
    subjectType: 'pull_request',
    subjectId: created.subjectId,
    number: 12,
    title: 'A change',
    event,
    ...extra,
  } as any)
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
        .values({ name: 'Notified', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.actorId = await make('nact')
    created.watcherId = await make('nwat')
    created.quietId = await make('nqui')
    created.strangerId = await make('nstr')

    // The actor is subscribed too, as the author. That is the point: being
    // subscribed must not be enough to hear about your own action.
    const subs: Array<[number, string, boolean]> = [
      [created.actorId, 'author', false],
      [created.watcherId, 'watching', false],
      [created.quietId, 'watching', true],
    ]

    for (const [userId, reason, unsubscribed] of subs) {
      await db.insertInto('notification_subscriptions').values({
        user_id: userId,
        subject_type: 'pull_request',
        subject_id: created.subjectId,
        reason,
        unsubscribed,
      }).execute()
    }

    available = true
  }
  catch (error) {
    console.warn(`[notifications] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  const ids = [created.actorId, created.watcherId, created.quietId, created.strangerId].filter(Boolean)

  for (const id of ids) {
    await db.deleteFrom('notifications').where('user_id', '=', id).execute()
    await db.deleteFrom('notification_subscriptions').where('user_id', '=', id).execute()
    await db.deleteFrom('users').where('id', '=', id).execute()
  }
})

describe('an event reaching an inbox', () => {
  test('a subscriber is told, with the sentence and where it points', async () => {
    if (!available)
      return

    await fire('pr:opened')
    const inbox = await inboxOf(created.watcherId)

    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.type).toBe('pr:opened')
    expect(inbox[0]!.data.title).toBe('actor opened acme/forge#12: A change')
    expect(inbox[0]!.data.url).toBe('/acme/forge/pull/12/files')
  })

  /**
   * The rule that decides whether people keep notifications on. A forge that
   * tells you about your own merge is one you mute within a week, and being
   * subscribed as the author is exactly the case that gets it wrong.
   */
  test('the person who did it is never told about it', async () => {
    if (!available)
      return

    expect(await inboxOf(created.actorId)).toHaveLength(0)
  })

  /**
   * The unsubscribe is kept as a row rather than a deletion, so that a later
   * event cannot quietly resubscribe somebody. Reading it as anything other
   * than final would waste that.
   */
  test('an explicit unsubscribe survives the next event', async () => {
    if (!available)
      return

    await fire('pr:merged')

    expect(await inboxOf(created.quietId)).toHaveLength(0)
    expect(await inboxOf(created.watcherId)).toHaveLength(2)
  })

  /**
   * A repository watcher wants to know a pull request opened. They do not want
   * every comment on it, and a forge that sends both is a forge people mute.
   */
  test('a comment reaches the conversation, not everybody watching', async () => {
    if (!available)
      return

    const before = (await inboxOf(created.watcherId)).length
    await fire('comment:created')

    expect(await inboxOf(created.watcherId)).toHaveLength(before)
  })

  /**
   * A review request is aimed at a person rather than broadcast, so it has to
   * reach somebody subscribed to nothing at all.
   */
  test('a review request reaches somebody who was never subscribed', async () => {
    if (!available)
      return

    await fire('review:requested', { addressed: [created.strangerId] })
    const inbox = await inboxOf(created.strangerId)

    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.data.title).toBe('actor asked you to review acme/forge#12')
    expect(inbox[0]!.data.reason).toBe('review_requested')
  })

  test('the row says why it arrived, so the reader can act on it', async () => {
    if (!available)
      return

    const inbox = await inboxOf(created.watcherId)

    expect(inbox[0]!.data.reason).toBe('watching')
    expect(inbox[0]!.data.repository).toBe('acme/forge')
  })

  /**
   * A notification is a consequence of somebody else's action and must never be
   * able to fail it. By the time this runs a branch has moved.
   */
  test('a malformed event is dropped rather than thrown', async () => {
    if (!available)
      return

    const Notify = (await import('../../app/Listeners/Notify')).default

    expect(await Notify.handle({} as any)).toBeUndefined()
    expect(await Notify.handle({ event: 'nonsense' } as any)).toBeUndefined()
  })
})
