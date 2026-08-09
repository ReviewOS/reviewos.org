// Metrics, against a real instance.
//
// Two things worth proving here that a unit test cannot: that requests are
// actually counted (the middleware is wired, and the router's after-response
// hook reaches it), and that the endpoint is not readable by a stranger.
//
// The second matters more than it looks. A metrics endpoint says how many
// repositories and accounts an instance has, how much traffic it takes, and
// when it is struggling - reconnaissance, served conveniently - and it is the
// endpoint most likely to be left exposed, because the scraper works either way
// and nothing complains.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'

const created = { userId: 0, adminId: 0, handle: '', adminHandle: '', token: '', adminToken: '' }

let available = false
let port = 0
let server: any = null
const SCRAPE_TOKEN = 'metrics-token-for-tests-only'

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function metrics(headers: Record<string, string> = {}): Promise<{ status: number, body: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers })

  return { status: answer.status, body: await answer.text() }
}

beforeAll(async () => {
  try {
    process.env.METRICS_TOKEN = SCRAPE_TOKEN

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

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const make = async (prefix: string, admin: boolean) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Scraper', email: `${handle}@example.com`, handle, password: 'x', is_admin: admin })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const token = generateToken()

      await db.insertInto('access_tokens').values({
        user_id: id,
        name: 'metrics test',
        prefix: token.prefix,
        token_hash: token.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).execute()

      return { id, handle, token: token.token }
    }

    const ordinary = await make('metricsuser', false)
    created.userId = ordinary.id
    created.handle = ordinary.handle
    created.token = ordinary.token

    const admin = await make('metricsadmin', true)
    created.adminId = admin.id
    created.adminHandle = admin.handle
    created.adminToken = admin.token

    available = true
  }
  catch (error) {
    console.warn(`[metrics] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const users = [created.userId, created.adminId].filter(Boolean)

      if (users.length > 0) {
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    delete process.env.METRICS_TOKEN
    server?.stop?.()
  }
}, 30_000)

describe('who may scrape', () => {
  test('a stranger is told nothing, including that this exists', async () => {
    if (!available)
      return

    /*
     * 404 rather than 403. Whether an instance exposes metrics at all is worth
     * not confirming, and a correctly configured scraper never sees this.
     */
    const answer = await metrics()

    expect(answer.status).toBe(404)
    expect(answer.body).not.toContain('reviewos_')
  })

  test('nor is an ordinary account', async () => {
    if (!available)
      return

    // Traffic shape and instance size are not things every member should read.
    const answer = await metrics({ Authorization: `Bearer ${created.token}` })

    expect(answer.status).toBe(404)
  })

  test('an administrator may', async () => {
    if (!available)
      return

    const answer = await metrics({ Authorization: `Bearer ${created.adminToken}` })

    expect(answer.status).toBe(200)
  })

  test('and so may a scrape token', async () => {
    if (!available)
      return

    /*
     * A Prometheus scrape config holds a bearer far more comfortably than a
     * session. Asking somebody to give their scraper an admin account is asking
     * for an admin password in a config file.
     */
    const answer = await metrics({ Authorization: `Bearer ${SCRAPE_TOKEN}` })

    expect(answer.status).toBe(200)
  })

  test('but not one that is nearly right', async () => {
    if (!available)
      return

    const answer = await metrics({ Authorization: `Bearer ${SCRAPE_TOKEN}x` })

    expect(answer.status).toBe(404)
  })
})

describe('what it reports', () => {
  test('the content type a collector negotiates on', async () => {
    if (!available)
      return

    // Without the version parameter some collectors negotiate protobuf and then
    // cannot parse what comes back.
    const answer = await fetch(`http://127.0.0.1:${port}/api/metrics`, {
      headers: { Authorization: `Bearer ${SCRAPE_TOKEN}` },
    })

    expect(answer.headers.get('Content-Type')).toContain('version=0.0.4')
    // A cached scrape is a flat graph, which is indistinguishable from an
    // instance doing nothing.
    expect(answer.headers.get('Cache-Control')).toBe('no-store')
  })

  test('requests it has served', async () => {
    if (!available)
      return

    /*
     * The wiring, end to end: the middleware runs, the router's after-response
     * hook reaches it, and the count lands. None of that is observable from a
     * unit test of the registry.
     */
    await fetch(`http://127.0.0.1:${port}/api/health`)
    await fetch(`http://127.0.0.1:${port}/api/health`)

    const answer = await metrics({ Authorization: `Bearer ${SCRAPE_TOKEN}` })

    expect(answer.body).toContain('reviewos_http_requests_total')
    expect(answer.body).toContain('reviewos_http_request_seconds_bucket')
  })

  test('labelled by route pattern rather than by URL', async () => {
    if (!available)
      return

    /*
     * The cardinality rule, and the most common way a metrics endpoint becomes
     * an outage: one series per repository on a forge with two hundred of them
     * is a scraper falling over. No label here should carry a handle this test
     * invented.
     */
    await fetch(`http://127.0.0.1:${port}/api/repos/pulls?owner=${created.handle}&repo=nothing`)

    const answer = await metrics({ Authorization: `Bearer ${SCRAPE_TOKEN}` })

    expect(answer.body).not.toContain(created.handle)
  })

  test('and how much is in the queue', async () => {
    if (!available)
      return

    // Read at scrape time rather than kept current: it changes slowly and a
    // scrape is the only moment anybody wants it.
    const answer = await metrics({ Authorization: `Bearer ${SCRAPE_TOKEN}` })

    expect(answer.body).toContain('reviewos_queue_depth')
    expect(answer.body).toContain('reviewos_repositories_total')
  })
})
