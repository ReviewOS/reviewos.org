// The event bus, from an emit to a listener that did something.
//
// Everything downstream of a domain event - the inbox, webhooks, the audit log,
// the activity feed - hangs off `dispatch` reaching a registered listener, and
// nothing in this suite had ever asserted that it does. The webhook tests call
// the listener directly ("the event bus is not what this is about"), the
// notification tests call the notifier directly, and each of them is right on
// its own terms. Between them was the join, untested.
//
// It was also broken. `@stacksjs/events` kept its emitter in a module-level
// constant, so it was a singleton of the *module* - and three copies of that
// package were installed, because `stacks` and `@stacksjs/buddy` each carry
// their own range and bun hoists one while nesting the others. Boot registered
// listeners on one emitter; every action dispatched into another. The dispatch
// returned normally, having reached nobody, and `[events] registered 70
// listeners` printed at boot the whole time.
//
// So this asserts the least interesting thing in the product and the one whose
// absence cost the most: an event emitted the way the application emits it
// arrives somewhere.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, webhookId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Deliveries recorded for our webhook, first attempts only. */
async function deliveries(): Promise<any[]> {
  return db
    .selectFrom('webhook_deliveries')
    .select(['event'])
    .where('webhook_id', '=', created.webhookId)
    .where('attempt', '=', 1)
    .orderBy('id', 'asc')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('bus')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Bus', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const hook: any = await db.insertInto('webhooks').values({
      repository_id: created.repositoryId,
      // Unreachable deliberately: the delivery is refused by the SSRF policy
      // and still recorded, and what this file asserts is that the attempt was
      // made at all.
      url: 'http://127.0.0.1:1/hook',
      secret: 'shhh',
      events: '*',
      content_type: 'application/json',
      active: true,
      consecutive_failures: 0,
    }).returning(['id']).executeTakeFirst()

    created.webhookId = Number(hook?.id)

    available = true
  }
  catch (error) {
    console.warn(`[event-bus] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.webhookId) {
      await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', created.webhookId).execute()
      await db.deleteFrom('webhooks').where('id', '=', created.webhookId).execute()
    }
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('an emitted event reaches its listeners', () => {
  test('through the helper the application actually calls', async () => {
    if (!available)
      return

    const { notifyProgramsOnly } = await import('../../app/Notifications/emit')

    await notifyProgramsOnly('pr:synchronized', {
      actorId: 0,
      actorHandle: '',
      repositoryId: created.repositoryId,
      owner: created.handle,
      repository: created.name,
      subjectType: 'pull_request',
      subjectId: 1,
      number: 1,
      title: 'A change',
    } as any)

    // The listener is async and the dispatch is fire-and-forget, which is the
    // right shape - a webhook must not be able to fail the action that caused
    // it - so this waits rather than assuming.
    for (let attempt = 0; attempt < 20 && (await deliveries()).length === 0; attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 100))

    expect((await deliveries()).map(row => String(row.event))).toContain('pr:synchronized')
  }, 30_000)

  test('and the registration a listener declares is the one that fires', async () => {
    if (!available)
      return

    // Not a tautology: the registry in `app/Events.ts` and the `listensTo` on
    // the listener are two lists, and an event named in one and not the other
    // is an event that either never fires or fires with nothing listening.
    const listener = (await import('../../app/Listeners/DispatchWebhooks')).default
    const registry: any = (await import('../../app/Events')).default

    for (const event of listener.listensTo as string[])
      expect(String(registry[event] ?? '')).toContain('DispatchWebhooks')
  })
})
