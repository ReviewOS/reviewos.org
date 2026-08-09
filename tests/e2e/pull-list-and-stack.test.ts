// Listing pull requests, and reading a stack, over the API.
//
// Both endpoints exist because the CLI needed them and they did not - the rule
// this phase set for itself. So the things worth asserting are the ones a
// client actually depends on: that a cursor does not skip or repeat a row, that
// a repeat request is free, and that the stack comes back in merge order rather
// than in whatever order the rows were written.
//
// Needs a database and a socket. No git.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  token: '',
  handle: '',
  name: '',
  repositoryId: 0,
  /** Five pull requests, oldest first, three of them a stack. */
  ids: [] as number[],
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function get(path: string, extra: Record<string, string> = {}): Promise<{ status: number, headers: Headers, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json', ...extra },
  })

  return { status: answer.status, headers: answer.headers, body: await answer.json().catch(() => null) }
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

    created.handle = unique('list')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Lister', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.userId, 'list and stack test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.name = unique('listrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    /*
     * Deliberately given the *same* `created_at`.
     *
     * That is the case cursor pagination exists for and the case an ordering
     * without a tiebreaker gets wrong: rows written in the same millisecond
     * have no defined order between them, so a page boundary lands in the
     * middle of the group and one row is never returned. Five rows and a page
     * size of two puts a boundary inside the group twice over.
     */
    const sameInstant = new Date().toISOString()

    for (let index = 1; index <= 5; index += 1) {
      const row: any = await db
        .insertInto('pull_requests')
        .values({
          repository_id: created.repositoryId,
          number: index,
          title: `Change ${index}`,
          author_id: created.userId,
          state: 'open',
          head_branch: `change-${index}`,
          head_sha: String(index).repeat(40).slice(0, 40),
          base_branch: index <= 3 && index > 1 ? `change-${index - 1}` : 'main',
          base_sha: 'a'.repeat(40),
          draft: false,
          created_at: sameInstant,
        })
        .returning(['id'])
        .executeTakeFirst()

      created.ids.push(Number(row?.id))
    }

    // A stack: 1 ← 2 ← 3. Four and five stand alone.
    await db.updateTable('pull_requests').set({ stack_parent_id: created.ids[0] }).where('id', '=', created.ids[1]).execute()
    await db.updateTable('pull_requests').set({ stack_parent_id: created.ids[1] }).where('id', '=', created.ids[2]).execute()

    available = true
  }
  catch (error) {
    console.warn(`[pull-list-and-stack] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.repositoryId) {
        // Children first: a stack is a self-reference and the rows point at
        // each other.
        await db.updateTable('pull_requests').set({ stack_parent_id: null }).where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }

      if (created.userId) {
        await db.deleteFrom('access_tokens').where('user_id', '=', created.userId).execute()
        await db.deleteFrom('users').where('id', '=', created.userId).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('listing', () => {
  test('returns the open pull requests', async () => {
    if (!available)
      return

    const listed = await get(`/api/repos/pulls?owner=${created.handle}&repo=${created.name}`)

    expect(listed.status).toBe(200)
    expect(listed.body?.pull_requests).toHaveLength(5)
  })

  test('pages through all of them without skipping or repeating one', async () => {
    if (!available)
      return

    /*
     * The assertion the whole cursor design exists for, on the hardest input:
     * every row shares a timestamp, so the ordering is decided entirely by the
     * tiebreaker. An ordering without one loses a row here and nothing reports
     * a problem.
     */
    const seen: number[] = []
    let cursor: string | null = null
    let guard = 0

    do {
      const page: any = await get(
        `/api/repos/pulls?owner=${created.handle}&repo=${created.name}&per_page=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )

      for (const row of page.body?.pull_requests ?? [])
        seen.push(Number(row.number))

      cursor = page.body?.next ?? null
      guard += 1
    } while (cursor && guard < 10)

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(seen).size).toBe(5)
  })

  test('and stops rather than offering a cursor to an empty page', async () => {
    if (!available)
      return

    // A client that has to make one more request to discover it finished is a
    // client polling an empty page forever.
    let cursor: string | null = null
    let pages = 0

    do {
      const page: any = await get(
        `/api/repos/pulls?owner=${created.handle}&repo=${created.name}&per_page=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )

      cursor = page.body?.next ?? null
      pages += 1
    } while (cursor && pages < 5)

    expect(pages).toBe(1)
  })

  test('a repeat is free', async () => {
    if (!available)
      return

    const first = await get(`/api/repos/pulls?owner=${created.handle}&repo=${created.name}`)
    const tag = first.headers.get('ETag')

    expect(tag).toBeTruthy()

    const again = await get(
      `/api/repos/pulls?owner=${created.handle}&repo=${created.name}`,
      { 'If-None-Match': String(tag) },
    )

    expect(again.status).toBe(304)
  })

  test('narrows to the fields a caller asked for', async () => {
    if (!available)
      return

    // Four hundred open pull requests with a paragraph each is a megabyte of
    // prose to build a list of titles.
    const listed = await get(`/api/repos/pulls?owner=${created.handle}&repo=${created.name}&fields=title`)
    const first = listed.body?.pull_requests?.[0]

    expect(first).toHaveProperty('title')
    // The identifier is added back even when a caller drops it: a row nothing
    // can name is a row nothing can act on.
    expect(first).toHaveProperty('number')
    expect(first).not.toHaveProperty('body')
  })

  test('refuses a cursor that is not ours, by name', async () => {
    if (!available)
      return

    const listed = await get(`/api/repos/pulls?owner=${created.handle}&repo=${created.name}&cursor=nonsense`)

    expect(listed.status).toBe(422)
    expect(listed.body?.error?.field).toBe('cursor')
  })
})

describe('the stack', () => {
  test('comes back bottom first, which is merge order', async () => {
    if (!available)
      return

    const stack = await get(`/api/repos/pulls/stack?owner=${created.handle}&repo=${created.name}&number=3`)

    expect(stack.status).toBe(200)
    expect((stack.body?.stack ?? []).map((member: any) => member.number)).toEqual([1, 2, 3])
  })

  test('says which member you asked about', async () => {
    if (!available)
      return

    // So a client can render the position without matching numbers itself, and
    // so `reviewos stack` can put an arrow next to the right line.
    const stack = await get(`/api/repos/pulls/stack?owner=${created.handle}&repo=${created.name}&number=2`)
    const current = (stack.body?.stack ?? []).find((member: any) => member.is_current)

    expect(current?.number).toBe(2)
    expect(stack.body?.position).toBe(2)
    expect(stack.body?.total).toBe(3)
  })

  test('a pull request in no stack is a stack of one', async () => {
    if (!available)
      return

    /*
     * Rather than an empty list or a 404. Every pull request is in a stack; most
     * are in one of length one, and a client that has to special-case "no
     * stack" grows a branch that is wrong the day somebody stacks on it.
     */
    const stack = await get(`/api/repos/pulls/stack?owner=${created.handle}&repo=${created.name}&number=5`)

    expect((stack.body?.stack ?? []).map((member: any) => member.number)).toEqual([5])
    expect(stack.body?.total).toBe(1)
  })

  test('and a repeat of it is free too', async () => {
    if (!available)
      return

    const first = await get(`/api/repos/pulls/stack?owner=${created.handle}&repo=${created.name}&number=3`)
    const again = await get(
      `/api/repos/pulls/stack?owner=${created.handle}&repo=${created.name}&number=3`,
      { 'If-None-Match': String(first.headers.get('ETag')) },
    )

    expect(again.status).toBe(304)
  })
})

describe('who am I', () => {
  test('answers the handle behind the token', async () => {
    if (!available)
      return

    const who = await get('/api/user')

    expect(who.status).toBe(200)
    expect(who.body?.handle).toBe(created.handle)
  })

  test('and says so plainly when there is no credential', async () => {
    if (!available)
      return

    // `reviewos login` checks a token before storing it, so this answer is the
    // difference between "that token is wrong" and "the server is broken".
    const answer = await fetch(`http://127.0.0.1:${port}/api/user`, { headers: { Accept: 'application/json' } })

    expect(answer.status).toBe(401)
  })
})
