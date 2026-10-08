// The search page, rendered by the real router.
//
// stx swallows a throw in `<script server>` and renders the template with every
// variable undefined, so the way this page fails is a page that looks fine and
// finds nothing. These assert on strings only a working render can produce -
// and, most importantly, that a private repository matching the query does not
// appear in the HTML.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, ownerToken: '', outsiderToken: '', outsiderId: 0, publicId: 0, privateId: 0, handle: '', term: '', publicName: '', privateName: '' }

let available = false
let db: any
let server: any
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function page(path: string, token?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return await answer.text()
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

    // Like the database above: a machine with no search node skips rather than
    // failing five tests with a stack trace out of the driver.
    const { searchEngineReachable } = await import('../helpers/searchEngine')
    if (!await searchEngineReachable())
      throw new Error('no search engine is running - `./buddy setup` starts one')

    available = true
  }
  catch (error) {
    console.warn(`[search-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  created.handle = unique('sg')
  created.term = unique('zpterm')

  const owner: any = await db.insertInto('users')
    .values({ name: 'Page owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
    .returning(['id']).executeTakeFirst()
  created.ownerId = Number(owner?.id)

  const outsider: any = await db.insertInto('users')
    .values({ name: 'Page outsider', email: `${created.handle}x@example.com`, handle: `${created.handle}x`, password: 'x' })
    .returning(['id']).executeTakeFirst()
  created.outsiderId = Number(outsider?.id)

  const { createToken } = await import('@stacksjs/auth')
  const a: any = await createToken(created.ownerId, 'page owner')
  created.ownerToken = String(a?.plainTextToken ?? a?.token ?? a)
  const b: any = await createToken(created.outsiderId, 'page outsider')
  created.outsiderToken = String(b?.plainTextToken ?? b?.token ?? b)

  for (const [key, nameKey, visibility] of [['publicId', 'publicName', 'public'], ['privateId', 'privateName', 'private']] as const) {
    const name = `${unique('repo')}${created.term}`
    created[nameKey] = name
    const row: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user', owner_id: created.ownerId, name,
        description: `${created.term} description`, visibility,
        default_branch: 'main', disk_path: `${created.handle}/${name}.git`,
      })
      .returning(['id']).executeTakeFirst()
    created[key] = Number(row?.id)
  }

  const job: any = (await import('../../app/Jobs/IndexRepositoryJob')).default
  await job.handle({ repositoryId: created.publicId })
  await job.handle({ repositoryId: created.privateId })
  await new Promise(r => setTimeout(r, 800))
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
  finally { server?.stop?.() }
})

describe('the search page', () => {
  test('renders results rather than the signed-out or empty branch', async () => {
    if (!available)
      return

    const html = await page(`/search?q=${created.term}`, created.ownerToken)

    expect(html).toContain(created.publicName)
    // The tell that the server script threw: every variable undefined, so the
    // page renders its "type something above" branch with a query present.
    expect(html).not.toContain('Type something above to search')
  })

  test('does not put a private repository in the HTML for a stranger', async () => {
    if (!available)
      return

    // The one that matters. It is in the index and it matches.
    const html = await page(`/search?q=${created.term}`, created.outsiderToken)

    expect(html).toContain(created.publicName)
    expect(html).not.toContain(created.privateName)
  })

  test('nor for an anonymous reader', async () => {
    if (!available)
      return

    const html = await page(`/search?q=${created.term}`)

    expect(html).not.toContain(created.privateName)
  })

  test('the owner sees their private repository', async () => {
    if (!available)
      return

    const html = await page(`/search?q=${created.term}`, created.ownerToken)

    expect(html).toContain(created.privateName)
  })

  test('the tabs carry the query, or they are useless', async () => {
    if (!available)
      return

    const html = await page(`/search?q=${created.term}`, created.ownerToken)

    expect(html).toContain(`scope=issues`)
    expect(html).toContain(encodeURIComponent(created.term))
  })

  test('an empty search asks for one instead of saying nothing matched', async () => {
    if (!available)
      return

    const html = await page('/search')

    expect(html).toContain('Type something above to search')
  })
})
