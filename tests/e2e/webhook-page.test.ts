// The webhook settings page, through the real routes.
//
// stx renders a page with every variable undefined when a server script throws,
// so an empty delivery log and a broken page look identical - and "no
// deliveries yet" is exactly what somebody debugging a missing webhook expects
// to be wrong about. The assertions are on content only a script that ran could
// produce.
//
// The access rule is the other half. A webhook carries a URL somebody chose and
// a secret, so a reader without `repository:settings` gets 404 rather than 403:
// 403 would confirm to a stranger that this repository has webhooks configured,
// which is the one thing the page exists to protect.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, strangerId: 0, repositoryId: 0, webhookId: 0, ownerToken: '', strangerToken: '', repoName: '', ownerHandle: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, token?: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return { status: answer.status, html: await answer.text() }
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

    const make = async (prefix: string): Promise<{ id: number, handle: string, token: string }> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Hook', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'webhook page test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('whp')
    const stranger = await make('whs')

    created.ownerId = owner.id
    created.ownerHandle = owner.handle
    created.ownerToken = owner.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token
    created.repoName = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.repoName,
        description: 'created by the webhook page test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${created.repoName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const webhook: any = await db
      .insertInto('webhooks')
      .values({
        repository_id: created.repositoryId,
        url: 'https://ci.distinctive-endpoint.example/hooks/reviewos',
        secret: 'shhh',
        events: '*',
        content_type: 'application/json',
        active: true,
        consecutive_failures: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.webhookId = Number(webhook?.id)

    // One that arrived and one that did not, so the page has both to render.
    await db.insertInto('webhook_deliveries').values({
      webhook_id: created.webhookId,
      event: 'pr:opened',
      payload: '{"event":"pr:opened"}',
      request_headers: '{}',
      response_status: 200,
      response_body: 'ok',
      duration_ms: 42,
      attempt: 1,
      delivered_at: new Date().toISOString(),
    }).execute()

    await db.insertInto('webhook_deliveries').values({
      webhook_id: created.webhookId,
      event: 'issue:closed',
      payload: '{"event":"issue:closed"}',
      request_headers: '{}',
      response_status: 404,
      response_body: 'no such route',
      duration_ms: 11,
      attempt: 1,
      delivered_at: new Date().toISOString(),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[webhook-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.webhookId) {
      await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', created.webhookId).execute()
      await db.deleteFrom('webhooks').where('id', '=', created.webhookId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      await db.deleteFrom('users').where('id', 'in', [created.ownerId, created.strangerId]).execute()
    }
  }
  finally {
    server?.stop?.()
  }
})

describe('the page an owner sees', () => {
  test('lists the webhook and its deliveries', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`, created.ownerToken)

    expect(html).toContain('ci.distinctive-endpoint.example')
    expect(html).toContain('pr:opened')
    expect(html).toContain('issue:closed')
  })

  test('says whose fault each failure is, in words rather than a status code', async () => {
    if (!available)
      return

    // The distinction that matters when debugging is not 200 versus 404, it is
    // whose handler is wrong. A page of raw codes makes every reader triage it
    // themselves and most of them do it wrong.
    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`, created.ownerToken)

    expect(html).toContain('Delivered')
    expect(html).toContain('Your endpoint refused it')
  })

  test('offers redelivery on each one', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`, created.ownerToken)

    expect(html).toContain('/api/repos/webhooks/redeliver')
    expect(html).toContain('Redeliver')
  })

  test('the secret is never on the page', async () => {
    if (!available)
      return

    // Shown once, when the webhook is created. A settings page that redisplays
    // it turns every shoulder and every screenshot into a leak.
    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`, created.ownerToken)

    expect(html).not.toContain('shhh')
  })
})

describe('who cannot see it', () => {
  test('a stranger gets not-found, not forbidden', async () => {
    if (!available)
      return

    // 403 would confirm that this repository has webhooks configured, which is
    // the one thing the page exists to protect.
    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`, created.strangerToken)

    expect(html).toContain('Not found')
    expect(html).not.toContain('ci.distinctive-endpoint.example')
  })

  test('and so does a signed-out reader', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.ownerHandle}/${created.repoName}/webhooks`)

    expect(html).not.toContain('ci.distinctive-endpoint.example')
  })
})
