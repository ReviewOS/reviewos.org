// What a mirror looks like from the outside: the banner a reader sees, and the
// button an operator presses.
//
// The banner is the point of the whole slice. A reader on a mirrored repository
// is deciding whether to trust the diff in front of them, and "mirror enabled"
// answers a different question than the one they have - so the page has to say
// when it last synced, and say something different when that was a long time
// ago with no error.
//
// Asked of the page rather than of `summarize`, because stx fails silently: a
// server script that throws renders with every variable undefined, so the
// banner would simply not appear and a mirror would look like an ordinary
// repository. That does not read as a failure.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, ownerToken: '', outsiderId: 0, outsiderToken: '', repositoryId: 0, mirrorId: 0, name: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function page(path: string, token?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return await answer.text()
}

async function post(path: string, token: string, body: Record<string, unknown>): Promise<{ status: number, json: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  return { status: answer.status, json: await answer.json().catch(() => null) }
}

/** Move the mirror's clock, so a state can be arranged without waiting for it. */
async function setSynced(iso: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await (globalThis as any).db
    .updateTable('repository_mirrors')
    .set({ last_synced_at: iso, ...extra })
    .where('id', '=', created.mirrorId)
    .execute()
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

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Mirror Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'mirror surface test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('msu')
    const outsider = await make('msx')

    created.ownerId = owner.id
    created.ownerToken = owner.token
    created.outsiderId = outsider.id
    created.outsiderToken = outsider.token
    created.name = unique('mrepo')

    const repo: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        // Public, so the banner can be asked for without a session too.
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${owner.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repo?.id)
    ;(created as any).ownerHandle = owner.handle

    const mirror: any = await db
      .insertInto('repository_mirrors')
      .values({
        repository_id: created.repositoryId,
        provider: 'github',
        remote_url: 'https://github.com/acme/api.git',
        remote_owner: 'acme',
        remote_name: 'api',
        interval_seconds: 900,
        enabled: true,
        last_synced_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.mirrorId = Number(mirror?.id)

    available = true
  }
  catch (error) {
    console.warn(`[mirror-surface] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      const users = [created.ownerId, created.outsiderId].filter(Boolean)
      if (users.length > 0) {
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('the banner', () => {
  test('says it is a mirror, and of what', async () => {
    if (!available)
      return

    const html = await page(`/${(created as any).ownerHandle}/${created.name}`)

    expect(html).toContain('Mirrored from')
    expect(html).toContain('acme/api')
  })

  test('and when it last synced, which is the reader\'s actual question', async () => {
    if (!available)
      return

    const html = await page(`/${(created as any).ownerHandle}/${created.name}`)

    // "Synced 3 minutes ago" beats "mirror enabled" - somebody about to review
    // a diff is deciding whether to trust it.
    expect(html).toContain('synced')
    expect(html).toContain('mirror-syncing')
  })

  test('warns when it has stopped tracking and nothing has errored', async () => {
    if (!available)
      return

    /*
     * The silent one. A mirror whose schedule stopped firing has no error and
     * looks exactly like a mirror of a quiet repository, so without this the
     * reader is told nothing and reads month-old code believing it is today's.
     */
    await setSynced(new Date(Date.now() - 30 * 86_400_000).toISOString())

    const html = await page(`/${(created as any).ownerHandle}/${created.name}`)

    expect(html).toContain('mirror-stale')
    expect(html).toContain('has not synced recently')
  })

  test('and names a revoked credential as the one failure with a different fix', async () => {
    if (!available)
      return

    await setSynced(new Date().toISOString(), {
      failure_count: 5,
      last_error: 'fatal: Authentication failed for https://github.com/acme/api.git',
    })

    const html = await page(`/${(created as any).ownerHandle}/${created.name}`)

    // Every other error is "wait or retry"; this one is "go and issue a new
    // token", and they read identically in a log.
    expect(html).toContain('Re-authorize')

    await setSynced(new Date().toISOString(), { failure_count: 0, last_error: null })
  })

  test('does not appear on a repository that is not a mirror', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const plain = unique('prepo')
    const row: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: plain,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${plain}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    const html = await page(`/${(created as any).ownerHandle}/${plain}`)

    expect(html).not.toContain('Mirrored from')

    await db.deleteFrom('repositories').where('id', '=', Number(row.id)).execute()
  })
})

describe('sync now', () => {
  test('is refused for somebody who cannot configure the mirror', async () => {
    if (!available)
      return

    // A sync spends somebody else's rate limit. A public mirror anybody could
    // trigger is a way to get this instance's token banned.
    const refused = await post('/api/mirrors/sync', created.outsiderToken, {
      owner: (created as any).ownerHandle,
      repository: created.name,
    })

    expect(refused.status).toBeGreaterThanOrEqual(400)
  })

  test('refuses a repository that is not a mirror', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const plain = unique('prepo')
    const row: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: plain,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${plain}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    const refused = await post('/api/mirrors/sync', created.ownerToken, {
      owner: (created as any).ownerHandle,
      repository: plain,
    })

    expect(refused.status).toBe(404)

    await db.deleteFrom('repositories').where('id', '=', Number(row.id)).execute()
  })

  test('refuses a second press within the cooldown, rather than racing itself', async () => {
    if (!available)
      return

    /*
     * Not about abuse so much as about the button being pressed three times
     * because nothing visibly happened. Three sweeps of the same repository
     * race each other into the same refs.
     */
    await setSynced(new Date().toISOString())

    const refused = await post('/api/mirrors/sync', created.ownerToken, {
      owner: (created as any).ownerHandle,
      repository: created.name,
    })

    expect(refused.status).toBe(429)
    expect(refused.json?.retry_in_seconds).toBeGreaterThan(0)
  })

  test('refuses a mirror that was deliberately switched off', async () => {
    if (!available)
      return

    // One sync would make it current and then let it drift again, which is more
    // confusing than it staying visibly stale.
    await setSynced(new Date(Date.now() - 86_400_000).toISOString(), { enabled: false })

    const refused = await post('/api/mirrors/sync', created.ownerToken, {
      owner: (created as any).ownerHandle,
      repository: created.name,
    })

    expect(refused.status).toBe(409)

    await setSynced(new Date(Date.now() - 86_400_000).toISOString(), { enabled: true })
  })

  test('queues it for somebody who may, outside the cooldown', async () => {
    if (!available)
      return

    const queued = await post('/api/mirrors/sync', created.ownerToken, {
      owner: (created as any).ownerHandle,
      repository: created.name,
    })

    /*
     * `202` with an operation, not `200` with `{ queued: true }`.
     *
     * The old answer told a caller nothing they could act on: no way to ask
     * whether it started, whether it finished, or why it did not. The operation
     * carries a status URL, which is the whole point of the pattern.
     */
    expect(queued.status).toBe(202)
    expect(queued.json?.operation?.status).toBe('queued')
    expect(queued.json?.operation?.url).toContain('/api/operations/')
    // Still reported, because something already read it. Adding a field is
    // safe; removing one is a breaking change to somebody else's script.
    expect(queued.json?.mirror_id).toBeGreaterThan(0)
  })
})
