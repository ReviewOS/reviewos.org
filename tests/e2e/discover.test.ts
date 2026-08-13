import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  handle: '',
  publicRepositoryId: 0,
  privateRepositoryId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('activity_events').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    created.handle = unique('discoverer')
    const user: any = await db
      .insertInto('users')
      .values({
        name: 'Discover Author',
        email: `${created.handle}@example.com`,
        handle: created.handle,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const repository = async (name: string, visibility: string): Promise<number> => {
      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.userId,
          name,
          visibility,
          default_branch: 'main',
          disk_path: `${created.handle}/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.publicRepositoryId = await repository(unique('public'), 'public')
    created.privateRepositoryId = await repository(unique('private'), 'private')

    const event = async (repositoryId: number, title: string): Promise<void> => {
      const repositoryName = repositoryId === created.publicRepositoryId ? 'public' : 'private'

      await db.insertInto('activity_events').values({
        actor_id: created.userId,
        verb: 'opened_pull_request',
        subject_type: 'pull_request',
        subject_id: Math.floor(Math.random() * 10_000) + 1,
        repository_id: repositoryId,
        is_public: true,
        detail: JSON.stringify({
          repository: `${created.handle}/${repositoryName}`,
          number: 12,
          title,
          tag: '',
        }),
      }).execute()
    }

    await event(created.publicRepositoryId, 'discover-public-first')
    await event(created.publicRepositoryId, 'discover-public-second')

    // It was public when recorded, then became private. Discovery must not keep
    // advertising a repository the reader can no longer open.
    await event(created.privateRepositoryId, 'discover-now-private')

    available = true
  }
  catch (error) {
    console.warn(`[discover] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('activity_events').where('actor_id', '=', created.userId).execute()
      await db.deleteFrom('repositories').where('owner_id', '=', created.userId).where('owner_type', '=', 'user').execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('discover feed', () => {
  test('lists current public activity and omits repositories that are private now', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/discover`)
    const body = await answer.json()
    const titles = body.entries.map((entry: any) => entry.title)

    expect(answer.status).toBe(200)
    expect(titles).toContain('discover-public-first')
    expect(titles).toContain('discover-public-second')
    expect(titles).not.toContain('discover-now-private')
  }, 60_000)

  test('uses a stable cursor rather than an offset', async () => {
    if (!available)
      return

    const { discoverFeed } = await import('../../app/Actions/Feed/read')
    const first = await discoverFeed({ limit: 1 })
    const second = await discoverFeed({ before: first.cursor, limit: 1 })

    expect(first.entries).toHaveLength(1)
    expect(first.cursor).not.toBeNull()
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].id).not.toBe(first.entries[0].id)
  }, 60_000)

  test('renders the feed and its repository discovery alongside it', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/discover`)
    const html = await answer.text()

    expect(answer.status).toBe(200)
    expect(html).toContain('Discover')
    expect(html).toContain('Recent activity')
    expect(html).toContain('Trending this week')
    expect(html).toContain('discover-public-first')
    expect(html).not.toContain('discover-now-private')
  }, 60_000)
})
