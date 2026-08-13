// What the shared header points at, per reader.
//
// This product has twice shipped a page nothing linked to: fourteen links to a
// profile that did not exist, and six settings pages reachable only by typing
// the URL. `/new` was the third - creating a repository is the first thing
// anybody does on a forge, and the only way to reach it was to know the path.
//
// The other half is what a signed-out visitor sees. A "New" link for somebody
// with no account is a link to a form that will turn them away, and a
// components-in-the-layout mistake is exactly how that ships: the component
// renders its markup and the guard inside it is what decides.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let available = false
let port = 0
let server: any = null
let token = ''
let handle = ''
let userId = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, cookie?: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(cookie ? { Cookie: `auth-token=${cookie}` } : {}) },
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

    handle = unique('hdr')

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Header Person', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    userId = Number(row?.id)

    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(userId, 'header links test')

    token = String(issued?.plainTextToken ?? issued?.token ?? issued)
    available = true
  }
  catch (error) {
    console.warn(`[header-links] skipping: ${(error as Error).message}`)
    available = false
  }
})

afterAll(async () => {
  if (userId) {
    const db = (globalThis as any).db
    await db.deleteFrom('users').where('id', '=', userId).execute().catch(() => {})
  }

  await server?.stop?.()
})

describe('the header', () => {
  test('points a signed-in reader at the page that creates a repository', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage('/explore', token)

    expect(status).toBe(200)
    expect(html).toContain('href="/new"')
  })

  test('and offers nothing of the sort to somebody signed out', async () => {
    if (!available)
      return

    // A link to a form that will turn them away is worse than no link: it reads
    // as the product being broken rather than as an account being needed.
    const { status, html } = await fetchPage('/explore')

    expect(status).toBe(200)
    expect(html).not.toContain('href="/new"')
  })
})
