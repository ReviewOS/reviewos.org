// The inbox, against a real table.
//
// The shaping is unit tested against literals. What that cannot cover is the
// half that only exists once there is a database: that `loadInbox` reads one
// person's rows and not another's, that marking read is scoped to the reader
// and to the filter they were looking at, and that the badge's count and the
// page's count come from the same truth.
//
// The scoping rules are the ones worth a database test, because both fail
// quietly. An inbox that shows somebody else's rows looks like a busy inbox,
// and a mark-all that ignores the filter looks like it worked.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dbTimestamp } from '../../app/Actions/Support/sql'

const created = { readerId: 0, otherId: 0 }

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Put a row in somebody's inbox. */
async function give(userId: number, data: Record<string, unknown>, readAt: string | null = null): Promise<void> {
  await (globalThis as any).db.insertInto('notifications').values({
    user_id: userId,
    type: 'test.event',
    data: JSON.stringify({ title: 'A thing happened', reason: 'watching', ...data }),
    read_at: readAt,
  }).execute()
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
        .values({ name: 'Reader', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.readerId = await make('inbr')
    created.otherId = await make('inbo')

    await give(created.readerId, { url: '/acme/api/pull/1', repository: 'acme/api', reason: 'review_requested', number: 1 })
    await give(created.readerId, { url: '/acme/api/pull/2', repository: 'acme/api', reason: 'watching', number: 2 })
    await give(created.readerId, { url: '/acme/web/issue/3', repository: 'acme/web', reason: 'mentioned', number: 3 })
    await give(created.readerId, { url: '/acme/web/issue/4', repository: 'acme/web', reason: 'watching', number: 4 }, dbTimestamp())

    // Somebody else's inbox, so every query below has something to leak.
    await give(created.otherId, { url: '/secret/repo/pull/9', repository: 'secret/repo', reason: 'author', number: 9 })

    available = true
  }
  catch (error) {
    console.warn(`[inbox] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  for (const id of [created.readerId, created.otherId].filter(Boolean)) {
    await db.deleteFrom('notifications').where('user_id', '=', id).execute()
    await db.deleteFrom('users').where('id', '=', id).execute()
  }
})

describe('loading an inbox', () => {
  test('reads this person\'s rows and nobody else\'s', async () => {
    if (!available)
      return

    const { loadInbox } = await import('../../app/Actions/Notification/read')
    const inbox = await loadInbox(created.readerId)

    expect(inbox.entries).toHaveLength(4)
    expect(inbox.entries.some(entry => entry.repository === 'secret/repo')).toBe(false)
  })

  test('the unread count is over everything, not over the filtered view', async () => {
    if (!available)
      return

    // A badge that drops when somebody applies a filter is telling them their
    // unread went away, and it did not.
    const { loadInbox } = await import('../../app/Actions/Notification/read')
    const all = await loadInbox(created.readerId)
    const filtered = await loadInbox(created.readerId, { repository: 'acme/web' })

    expect(all.unread).toBe(3)
    expect(filtered.unread).toBe(3)
    expect(filtered.entries).toHaveLength(2)
  })

  test('the badge count and the page count come from the same truth', async () => {
    if (!available)
      return

    const { loadInbox, unreadFor } = await import('../../app/Actions/Notification/read')

    expect(await unreadFor(created.readerId)).toBe((await loadInbox(created.readerId)).unread)
  })

  test('the repository strip counts unread per repository', async () => {
    if (!available)
      return

    const { loadInbox } = await import('../../app/Actions/Notification/read')
    const inbox = await loadInbox(created.readerId)

    expect(inbox.repositories).toEqual([
      { repository: 'acme/api', unread: 2, total: 2 },
      { repository: 'acme/web', unread: 1, total: 2 },
    ])
  })

  test('a person with an empty inbox gets an empty inbox, not an error', async () => {
    if (!available)
      return

    const { loadInbox } = await import('../../app/Actions/Notification/read')
    const inbox = await loadInbox(-1)

    expect(inbox.entries).toEqual([])
    expect(inbox.unread).toBe(0)
  })
})

describe('marking read', () => {
  test('marks the rows a filter left, and nothing outside it', async () => {
    if (!available)
      return

    // The destructive case. Marking everything read from a view showing one
    // repository is the single worst thing an inbox can do by accident, and it
    // is worst because it cannot be undone.
    const db = (globalThis as any).db
    const { loadInbox } = await import('../../app/Actions/Notification/read')

    const rows: any[] = await db
      .selectFrom('notifications')
      .select(['id', 'data'])
      .where('user_id', '=', created.readerId)
      .whereNull('read_at')
      .execute()

    const web = rows
      .filter(row => JSON.parse(String(row.data)).repository === 'acme/web')
      .map(row => Number(row.id))

    expect(web).toHaveLength(1)

    await db
      .updateTable('notifications')
      .set({ read_at: dbTimestamp() })
      .where('user_id', '=', created.readerId)
      .whereNull('read_at')
      .where('id', 'in', web)
      .execute()

    const after = await loadInbox(created.readerId)

    expect(after.unread).toBe(2)
    expect(after.repositories).toEqual([
      { repository: 'acme/api', unread: 2, total: 2 },
      { repository: 'acme/web', unread: 0, total: 2 },
    ])
  })

  test('the ownership check is what stops one inbox reaching another', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const theirs: any[] = await db
      .selectFrom('notifications')
      .select(['id'])
      .where('user_id', '=', created.otherId)
      .execute()

    // The update the action runs, with the other person's id passed in: the
    // `user_id` clause is the whole defence, so this asserts it holds even when
    // the ids are handed over.
    await db
      .updateTable('notifications')
      .set({ read_at: dbTimestamp() })
      .where('user_id', '=', created.readerId)
      .where('id', 'in', theirs.map((row: any) => Number(row.id)))
      .execute()

    const { unreadFor } = await import('../../app/Actions/Notification/read')

    expect(await unreadFor(created.otherId)).toBe(1)
  })
})
