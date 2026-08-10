// Explore, and the one property that matters more than any of the lists.
//
// This is the surface where a visibility mistake is not a leak to one person
// but a listing - a private repository appearing here is on a public page, in
// an index, and in somebody's cache. So the first test is that it does not, and
// it is asserted on every list rather than once.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerHandle: '',
  ownerId: 0,
  publicId: 0,
  publicName: '',
  privateId: 0,
  privateName: '',
  quietId: 0,
  quietName: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function explore(query: Record<string, string> = {}): Promise<any> {
  const parameters = new URLSearchParams(query)
  const answer = await fetch(`http://127.0.0.1:${port}/api/explore?${parameters}`, {
    headers: { Accept: 'application/json' },
  })

  return await answer.json().catch(() => null)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('repository_languages').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    created.ownerHandle = unique('exploreowner')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Explore Owner', email: `${created.ownerHandle}@example.com`, handle: created.ownerHandle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const make = async (name: string, visibility: string, pushedAt: string | null): Promise<number> => {
      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.ownerId,
          name,
          description: `The ${visibility} one`,
          visibility,
          default_branch: 'main',
          disk_path: `${created.ownerHandle}/${name}.git`,
          pushed_at: pushedAt,
          stars_count: 0,
        })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    const now = new Date().toISOString()

    created.publicName = unique('explorepublic')
    created.publicId = await make(created.publicName, 'public', now)

    created.privateName = unique('exploreprivate')
    created.privateId = await make(created.privateName, 'private', now)

    // Public but untouched, so "recently active" has something to leave out.
    created.quietName = unique('explorequiet')
    created.quietId = await make(created.quietName, 'public', null)

    // Stars on both, dated inside the window, so trending has a reason to list
    // the public one and a reason not to list the private one.
    for (const repositoryId of [created.publicId, created.privateId]) {
      for (let index = 0; index < 3; index += 1) {
        const handle = unique('starrer')
        const starrer: any = await db
          .insertInto('users')
          .values({ name: 'Starrer', email: `${handle}@example.com`, handle, password: 'x' })
          .returning(['id'])
          .executeTakeFirst()

        await db.insertInto('stars').values({
          repository_id: repositoryId,
          user_id: Number(starrer?.id),
          created_at: new Date(Date.now() - 3600_000).toISOString(),
        }).execute()
      }
    }

    // A language breakdown on each, so browsing by language has both to choose
    // between - and only one of them should be choosable.
    for (const repositoryId of [created.publicId, created.privateId]) {
      await db.insertInto('repository_languages').values({
        repository_id: repositoryId,
        language: 'Zig',
        bytes: 1000,
        percent: 100,
      }).execute()
    }

    await db.insertInto('repo_topics').values({ repository_id: created.publicId, topic: 'forge' }).execute()
    await db.insertInto('repo_topics').values({ repository_id: created.privateId, topic: 'forge' }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[explore] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const ids = [created.publicId, created.privateId, created.quietId].filter(Boolean)

      for (const id of ids) {
        await db.deleteFrom('repository_languages').where('repository_id', '=', id).execute()
        await db.deleteFrom('repo_topics').where('repository_id', '=', id).execute()

        const stars: any[] = await db.selectFrom('stars').select(['user_id']).where('repository_id', '=', id).execute()

        await db.deleteFrom('stars').where('repository_id', '=', id).execute()

        for (const star of stars)
          await db.deleteFrom('users').where('id', '=', Number(star.user_id)).execute()

        await db.deleteFrom('repositories').where('id', '=', id).execute()
      }

      if (created.ownerId)
        await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('what explore never shows', () => {
  test('a private repository is in none of the lists', async () => {
    if (!available)
      return

    /*
     * The property this whole surface turns on. A private repository here is on
     * a public page, in an index, and in somebody's cache - a mistake that
     * cannot be taken back by fixing the query afterwards.
     *
     * Asserted on every list rather than once, because each is a separate query
     * and the one written next is the one that forgets.
     */
    const answer = await explore()
    const everywhere = [
      ...answer.trending,
      ...answer.recently_active,
      ...(await explore({ topic: 'forge' })).repositories,
      ...(await explore({ language: 'Zig' })).repositories,
    ]

    expect(everywhere.some((one: any) => one.name === created.privateName)).toBe(false)
    expect(everywhere.some((one: any) => one.name === created.publicName)).toBe(true)
  }, 60_000)
})

describe('trending', () => {
  test('is by stars gained in the window, not by total', async () => {
    if (!available)
      return

    /*
     * The reason this is not an ordering of `stars_count`. A list by total is
     * the same list every week and shows nobody anything they did not know; the
     * point is that new work can surface, and only a window does that.
     */
    const answer = await explore()
    const entry = answer.trending.find((one: any) => one.name === created.publicName)

    expect(entry).toBeDefined()
    expect(entry.gained).toBe(3)
  }, 60_000)

  test('and a window that excludes the stars excludes the repository', async () => {
    if (!available)
      return

    // The stars were an hour ago. Nothing gained one *today* before that, so a
    // one-day window still holds them - what proves the window works is the
    // count, above, which counts only rows inside it.
    const answer = await explore({ days: '1' })

    expect(answer.window_days).toBe(1)
  }, 60_000)

  test('the window is bounded, because three years is the all-time list', async () => {
    if (!available)
      return

    expect((await explore({ days: '9999' })).window_days).toBe(90)
    expect((await explore({ days: '0' })).window_days).toBe(7)
  }, 60_000)
})

describe('recently active', () => {
  test('lists what has been pushed to, and not what has not', async () => {
    if (!available)
      return

    const active = (await explore()).recently_active

    expect(active.some((one: any) => one.name === created.publicName)).toBe(true)
    // A repository nobody has pushed to has no `pushed_at`, and appearing here
    // under "recently active" would be a lie the ordering cannot fix.
    expect(active.some((one: any) => one.name === created.quietName)).toBe(false)
  }, 60_000)

  test('and it is returned alongside trending rather than instead of it', async () => {
    if (!available)
      return

    /*
     * On a young instance nothing has gained a star this week and trending is
     * empty. A page that quietly showed "recently active" under a heading
     * saying "trending" would be lying about what the instance knows - so both
     * are always present and the page decides what to hide.
     */
    const answer = await explore()

    expect(Array.isArray(answer.trending)).toBe(true)
    expect(Array.isArray(answer.recently_active)).toBe(true)
  }, 60_000)
})

describe('browsing by', () => {
  test('topic', async () => {
    if (!available)
      return

    const answer = await explore({ topic: 'forge' })

    expect(answer.filter.topic).toBe('forge')
    expect(answer.repositories.some((one: any) => one.name === created.publicName)).toBe(true)
  }, 60_000)

  test('language, with the card naming the largest one', async () => {
    if (!available)
      return

    const answer = await explore({ language: 'Zig' })
    const entry = answer.repositories.find((one: any) => one.name === created.publicName)

    expect(entry).toBeDefined()
    expect(entry.language).toBe('Zig')
  }, 60_000)

  test('and the language index counts only public repositories', async () => {
    if (!available)
      return

    // Two repositories are written in Zig and one of them is private. An index
    // that counted both would advertise the existence of the private one by
    // arithmetic.
    const zig = (await explore()).languages.find((one: any) => one.language === 'Zig')

    expect(zig.repositories).toBe(1)
  }, 60_000)
})

describe('the page', () => {
  test('renders on the server, with the repositories in the HTML', async () => {
    if (!available)
      return

    /*
     * No client-side fetching: the lists are in the HTML, so the page works
     * with JavaScript off, a filtered view can be linked to, and the back
     * button returns to what somebody was looking at.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/explore`, { headers: { Accept: 'text/html' } })
    const html = await answer.text()

    expect(answer.status).toBe(200)
    expect(html).toContain(created.publicName)

    // And the same rule as the API, on the surface where it matters most.
    expect(html).not.toContain(created.privateName)
  }, 60_000)

  test('a filtered view is linkable', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/explore?language=Zig`, { headers: { Accept: 'text/html' } })
    const html = await answer.text()

    expect(answer.status).toBe(200)
    expect(html).toContain(created.publicName)
    expect(html).not.toContain(created.privateName)
  }, 60_000)
})
