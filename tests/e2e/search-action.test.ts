// Search, through the route a browser would call.
//
// `search-visibility.test.ts` pins the filter against injected candidate lists.
// This is the other half: a real index, a real query, a real HTTP request, and
// the assertion that a private repository which genuinely matches the search
// term does not come back to somebody who cannot read it.
//
// That distinction matters. The unit-level test proves the filter works when it
// is called. This proves it is actually called, on the path a reader takes,
// with a document sitting in the index that would otherwise be returned.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, outsiderId: 0, outsiderToken: '', publicId: 0, privateId: 0, handle: '', term: '' }

let available = false
let db: any
let server: any
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function search(query: string, token?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)
    if (!port)
      throw new Error('the router did not report a port')

    available = true
  }
  catch (error) {
    console.warn(`[search-action] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  created.handle = unique('sa')
  // A term that appears in both repositories and nowhere else in the corpus, so
  // a hit is unambiguous and a miss cannot be a coincidence.
  created.term = unique('zqterm')

  const owner: any = await db
    .insertInto('users')
    .values({ name: 'Search owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()
  created.ownerId = Number(owner?.id)

  const outsider: any = await db
    .insertInto('users')
    .values({ name: 'Search outsider', email: `${created.handle}x@example.com`, handle: `${created.handle}x`, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()
  created.outsiderId = Number(outsider?.id)

  const { createToken } = await import('@stacksjs/auth')
  const issued: any = await createToken(created.outsiderId, 'search action test')
  created.outsiderToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

  for (const [key, visibility] of [['publicId', 'public'], ['privateId', 'private']] as const) {
    const name = `${unique('repo')}${created.term}`
    const row: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name,
        description: `${created.term} in the description too`,
        visibility,
        default_branch: 'main',
        disk_path: `${created.handle}/${name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created[key] = Number(row?.id)
  }

  // Both go into the index, private one included - that is the normal state and
  // the whole reason the filter has to exist.
  const job: any = (await import('../../app/Jobs/IndexRepositoryJob')).default
  await job.handle({ repositoryId: created.publicId })
  await job.handle({ repositoryId: created.privateId })
  await new Promise(resolve => setTimeout(resolve, 800))
}, 120_000)

afterAll(async () => {
  try {
    const repositories = [created.publicId, created.privateId].filter(Boolean)
    if (db && repositories.length > 0)
      await db.deleteFrom('repositories').where('id', 'in', repositories).execute()

    const users = [created.ownerId, created.outsiderId].filter(Boolean)
    if (db && users.length > 0) {
      await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
      await db.deleteFrom('users').where('id', 'in', users).execute()
    }
  }
  catch { /* a failed setup leaves less behind than it made */ }
  finally {
    server?.stop?.()
  }
})

describe('searching through the route', () => {
  test('the owner finds both of their repositories', async () => {
    if (!available)
      return

    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.ownerId, 'owner search')
    const { status, body } = await search(created.term, String(issued?.plainTextToken ?? issued?.token ?? issued))

    expect(status).toBe(200)

    const ids = body.results.map((r: any) => r.id)
    expect(ids).toContain(created.publicId)
    expect(ids).toContain(created.privateId)
  })

  test('a stranger finds only the public one, though both match', async () => {
    if (!available)
      return

    // The private repository is in the index and matches the term. The only
    // thing keeping its name off this response is the filter.
    const { status, body } = await search(created.term, created.outsiderToken)

    expect(status).toBe(200)

    const ids = body.results.map((r: any) => r.id)
    expect(ids).toContain(created.publicId)
    expect(ids).not.toContain(created.privateId)
    expect(JSON.stringify(body)).not.toContain(String(created.privateId))
  })

  test('and neither does an anonymous reader', async () => {
    if (!available)
      return

    const { status, body } = await search(created.term)

    expect(status).toBe(200)
    expect(body.results.map((r: any) => r.id)).toEqual([created.publicId])
  })

  test('the total counts what the reader may see, not what matched', async () => {
    if (!available)
      return

    // Returning the index's own `found` would leak the count: "3 results" with
    // one row rendered tells a stranger two exist that they cannot read.
    const { body } = await search(created.term, created.outsiderToken)

    expect(body.total).toBe(body.results.length)
  })

  test('an empty query asks the index nothing', async () => {
    if (!available)
      return

    const { status, body } = await search('   ')

    expect(status).toBe(200)
    expect(body.results).toEqual([])
  })

  test('a scope that is not wired says so rather than returning nothing', async () => {
    if (!available)
      return

    // An empty list would read as "no matches", which is a lie that costs
    // somebody an afternoon.
    const answer = await fetch(`http://127.0.0.1:${port}/api/search?q=anything&scope=issues`, {
      headers: { Accept: 'application/json' },
    })

    expect(answer.status).toBe(501)
  })
})
