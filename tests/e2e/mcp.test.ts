// The MCP endpoint, through the real route, against the real API.
//
// The unit tests dispatch against a recorded caller and assert what gets sent.
// This asserts the thing only a running server can: that a tool call genuinely
// reaches this instance's own API carrying the caller's token, and that a token
// which cannot read a repository fails **the same way the API does** rather
// than similarly.
//
// That last one is the phase's own acceptance criterion, and it is only
// meaningful end to end - the whole design is that there is no second
// permission check to test in isolation.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. It needs no git.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  strangerId: 0,
  strangerToken: '',
  handle: '',
  name: '',
  repositoryId: 0,
}

let available = false
let port = 0
let server: any = null
let nextId = 1

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** One JSON-RPC call, the way an MCP client makes it. */
async function rpc(method: string, params: unknown, token?: string): Promise<any> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
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
        .values({ name: 'MCP Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'mcp test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('mcpo')
    const stranger = await make('mcpx')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token

    created.name = unique('mcprepo')
    const repo: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        // Private, which is the whole point of the refusal test below.
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repo?.id)

    await db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'A change worth reviewing',
      body: 'the body',
      author_id: created.ownerId,
      state: 'open',
      head_branch: 'change',
      head_sha: 'b'.repeat(40),
      base_branch: 'main',
      base_sha: 'a'.repeat(40),
      draft: false,
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[mcp] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      const users = [created.ownerId, created.strangerId].filter(Boolean)
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

describe('the handshake', () => {
  test('initializes and lists its tools', async () => {
    if (!available)
      return

    const started = await rpc('initialize', {}, created.ownerToken)
    expect(started.body?.result?.serverInfo?.name).toBe('reviewos')

    const listed = await rpc('tools/list', {}, created.ownerToken)
    const names = (listed.body?.result?.tools ?? []).map((tool: any) => tool.name)

    expect(names).toContain('read_pull_request')
    expect(names).toContain('read_pull_request_diff')
    expect(names).toContain('submit_review')
  })

  test('refuses a connection with no token, in JSON-RPC', async () => {
    if (!available)
      return

    /*
     * A bare 401 body leaves an MCP client reporting "the server returned
     * invalid JSON", which sends somebody looking for a parsing bug that is not
     * there. A client that spoke JSON-RPC deserves an answer in it.
     */
    const refused = await rpc('tools/list', {})

    expect(refused.status).toBe(401)
    expect(refused.body?.error?.message).toContain('token')
  })
})

describe('a tool call', () => {
  test('reaches the API as the caller and returns real data', async () => {
    if (!available)
      return

    const called = await rpc('tools/call', {
      name: 'read_pull_request',
      arguments: { owner: created.handle, repo: created.name, number: 1 },
    }, created.ownerToken)

    expect(called.body?.result?.isError).toBe(false)

    // The pull request itself, not a description of one - which is the proof
    // the call actually landed rather than being mocked away.
    const text = String(called.body?.result?.content?.[0]?.text ?? '')
    expect(text).toContain('A change worth reviewing')
  })

  test('and the diff tool returns structure, never HTML', async () => {
    if (!available)
      return

    /*
     * An agent handed HTML has to parse it back into hunks, which is a parser
     * it should never have had to write. The repository has no objects on disk
     * here, so this asserts the *shape* of the answer rather than its contents:
     * whatever comes back, it is JSON and it is not markup.
     */
    const called = await rpc('tools/call', {
      name: 'read_pull_request_diff',
      arguments: { owner: created.handle, repo: created.name, number: 1 },
    }, created.ownerToken)

    const text = String(called.body?.result?.content?.[0]?.text ?? '')

    expect(text).not.toContain('<div')
    expect(text).not.toContain('<table')
  })
})

describe('a token that cannot read the repository', () => {
  test('fails the same way the API does, not similarly', async () => {
    if (!available)
      return

    /*
     * The phase's own acceptance criterion, and the reason the server holds no
     * credential of its own: there is no second permission check here to
     * disagree with the API's.
     *
     * Asserted against the API's own answer rather than against a hard-coded
     * 404, so the two cannot drift apart - if the API ever started saying 403,
     * this would notice that the tool did not.
     */
    const direct = await fetch(
      `http://127.0.0.1:${port}/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      { headers: { Authorization: `Bearer ${created.strangerToken}`, Accept: 'application/json' } },
    )

    expect(direct.status).toBeGreaterThanOrEqual(400)

    const viaTool = await rpc('tools/call', {
      name: 'read_pull_request',
      arguments: { owner: created.handle, repo: created.name, number: 1 },
    }, created.strangerToken)

    expect(viaTool.body?.result?.isError).toBe(true)
    // The API's status, relayed.
    expect(String(viaTool.body?.result?.content?.[0]?.text ?? '')).toContain(String(direct.status))
  })

  test('reports the refusal to the model rather than as a protocol error', async () => {
    if (!available)
      return

    /*
     * A JSON-RPC error is a *protocol* failure and most clients surface it to
     * the operator rather than the model - so a model that asked about a
     * repository it cannot read would be told nothing and would try again.
     */
    const viaTool = await rpc('tools/call', {
      name: 'read_pull_request',
      arguments: { owner: created.handle, repo: created.name, number: 1 },
    }, created.strangerToken)

    expect(viaTool.body?.error).toBeUndefined()
    expect(viaTool.body?.result?.isError).toBe(true)
  })

  test('and cannot write either', async () => {
    if (!available)
      return

    const viaTool = await rpc('tools/call', {
      name: 'submit_review',
      arguments: { owner: created.handle, repo: created.name, number: 1, state: 'approved', body: 'lgtm' },
    }, created.strangerToken)

    expect(viaTool.body?.result?.isError).toBe(true)

    // And nothing was written, which is the assertion that matters.
    const reviews: any[] = await (globalThis as any).db
      .selectFrom('pull_request_reviews')
      .select(['id'])
      .where('reviewer_id', '=', created.strangerId)
      .execute()

    expect(reviews).toHaveLength(0)
  })
})
