// An event, out to every webhook that asked for it.
//
// The delivery job is tested next door and the payload shapes are a contract
// test. What neither covers is the join between them, and it is the half that
// fails silently: a webhook that quietly stops firing is the failure people
// notice weeks later, in somebody else's CI, and "no deliveries" looks exactly
// like "nothing happened".
//
// Three rules worth pinning:
//
//   - Only webhooks subscribed to this event fire. Filtering is done in the
//     application rather than with a SQL LIKE, because LIKE would match a
//     repository whose name contained an event name.
//   - Inactive webhooks do not fire.
//   - One body is built and shared, so the signature every receiver checks is
//     over the exact bytes that were sent.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, all: 0, one: 0, other: 0, off: 0 }

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Run the listener directly: the event bus is not what this is about. */
async function fire(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  const listener = (await import('../../app/Listeners/DispatchWebhooks')).default

  await listener.handle({
    actorId: created.ownerId,
    actorHandle: 'chris',
    repositoryId: created.repositoryId,
    owner: 'acme',
    repository: 'api',
    subjectType: 'pull_request',
    subjectId: 42,
    number: 12,
    title: 'A change',
    event,
    ...extra,
  } as any)
}

/**
 * First attempts recorded for one webhook.
 *
 * `attempt = 1`, not every row. Tests run the queue inline, so a delivery that
 * fails retries all the way to `MAX_ATTEMPTS` before this function is called
 * and every dispatch would count as six. First attempts are what "the listener
 * fired this webhook once" actually means, and the retry curve is the delivery
 * job's business, tested next door.
 */
async function deliveriesFor(webhookId: number): Promise<any[]> {
  return (globalThis as any).db
    .selectFrom('webhook_deliveries')
    .select(['event', 'payload'])
    .where('webhook_id', '=', webhookId)
    .where('attempt', '=', 1)
    .orderBy('id', 'asc')
    .execute()
}

async function makeWebhook(events: string, active = true): Promise<number> {
  const row: any = await (globalThis as any).db
    .insertInto('webhooks')
    .values({
      repository_id: created.repositoryId,
      // Unreachable on purpose. The delivery is refused by the SSRF policy and
      // still recorded, which is exactly what this file needs: it asserts that
      // an attempt was *made*, not that somebody's server answered.
      url: 'http://127.0.0.1:1/hook',
      secret: 'shhh',
      events,
      content_type: 'application/json',
      active,
      consecutive_failures: 0,
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(row?.id)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const handle = unique('whx')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Hook', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: unique('repo'),
        description: 'created by the webhook dispatch test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${unique('repo')}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    created.all = await makeWebhook('*')
    created.one = await makeWebhook('pr:opened')
    created.other = await makeWebhook('issue:closed')
    created.off = await makeWebhook('*', false)

    available = true
  }
  catch (error) {
    console.warn(`[webhook-dispatch] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  for (const id of [created.all, created.one, created.other, created.off].filter(Boolean)) {
    await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', id).execute()
    await db.deleteFrom('webhooks').where('id', '=', id).execute()
  }

  if (created.repositoryId)
    await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

  if (created.ownerId)
    await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
})

describe('who fires', () => {
  test('a webhook subscribed to everything', async () => {
    if (!available)
      return

    await fire('pr:opened')

    expect(await deliveriesFor(created.all)).toHaveLength(1)
  })

  test('a webhook subscribed to this event', async () => {
    if (!available)
      return

    expect(await deliveriesFor(created.one)).toHaveLength(1)
  })

  test('not one subscribed to a different event', async () => {
    if (!available)
      return

    expect(await deliveriesFor(created.other)).toHaveLength(0)
  })

  test('not an inactive one', async () => {
    if (!available)
      return

    expect(await deliveriesFor(created.off)).toHaveLength(0)
  })
})

describe('what is sent', () => {
  test('the payload is the documented shape, not a database row', async () => {
    if (!available)
      return

    const rows = await deliveriesFor(created.all)
    const body = JSON.parse(String(rows[0].payload))

    expect(body.event).toBe('pr:opened')
    expect(body.repository.full_name).toBe('acme/api')
    expect(body.subject).toMatchObject({ type: 'pull_request', number: 12 })
    expect(body.action).toBe('opened')
  })

  test('every receiver gets the identical bytes, so the signature reproduces', async () => {
    if (!available)
      return

    // Serializing per webhook would produce a different string for each, and a
    // signature the receiver cannot reproduce is worse than none: it teaches
    // them to stop checking.
    const [a] = await deliveriesFor(created.all)
    const [b] = await deliveriesFor(created.one)

    expect(String(a.payload)).toBe(String(b.payload))
  })
})

describe('an event nobody subscribed to', () => {
  test('reaches only the wildcard', async () => {
    if (!available)
      return

    await fire('issue:closed', { subjectType: 'issue' })

    expect(await deliveriesFor(created.all)).toHaveLength(2)
    expect(await deliveriesFor(created.one)).toHaveLength(1)
    expect(await deliveriesFor(created.other)).toHaveLength(1)
  })

  test('an event with no repository is dropped rather than fanned out', async () => {
    if (!available)
      return

    const before = (await deliveriesFor(created.all)).length

    await fire('pr:merged', { repositoryId: 0 })

    expect(await deliveriesFor(created.all)).toHaveLength(before)
  })
})
