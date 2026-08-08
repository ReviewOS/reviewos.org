// A token's hourly creation budget, through the real endpoint.
//
// The claim being tested is the one the feature exists for: a loop with no
// backoff hits a wall, and the wall tells it when to come back. Not "the
// counter increments" - that is the unit test's business - but that the
// increment is wired to the write, and that the refusal is the shape a client
// can act on.
//
// Needs a database and a socket. No git: a comment on a line writes rows and
// touches nothing on disk.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  token: '',
  tokenId: 0,
  handle: '',
  name: '',
  repositoryId: 0,
  pullRequestId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Leave one line comment, and report what the server said. */
async function comment(body: string): Promise<{ status: number, headers: Headers, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      owner: created.handle,
      repo: created.name,
      number: 1,
      path: 'src/a.ts',
      line: 1,
      side: 'right',
      body,
    }),
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

    created.handle = unique('lim')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Looping Agent', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    /*
     * One of *this project's* tokens, not `@stacksjs/auth`'s.
     *
     * The two are different credentials in different tables. The framework's
     * `createToken` writes `oauth_access_tokens` and is what most of the e2e
     * suite uses, because most endpoints only need to know who is calling. A
     * per-token budget lives on `access_tokens`, so a test holding the other
     * kind would exercise the unmetered path and pass while metering nothing.
     */
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const issued = generateToken()
    created.token = issued.token

    const tokenRow: any = await db
      .insertInto('access_tokens')
      .values({
        user_id: created.userId,
        name: 'token limit test',
        prefix: issued.prefix,
        token_hash: issued.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        // Two an hour, so the third is the one that has to be refused. A small
        // number rather than the default, because a test that makes three
        // hundred requests to prove a limit is a test nobody runs.
        limit_comments_per_hour: 2,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.tokenId = Number(tokenRow?.id)

    // The grants the endpoints need. A token with no rows here reaches every
    // repository its owner can and is allowed to do nothing in them, which is
    // the right default and not what this test is about.
    for (const scope of ['contents', 'pull_requests']) {
      await db
        .insertInto('access_token_permissions')
        .values({ access_token_id: created.tokenId, scope, level: 'write' })
        .execute()
    }

    created.name = unique('limrepo')
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

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Something to comment on',
        author_id: created.userId,
        state: 'open',
        head_branch: 'change',
        head_sha: 'b'.repeat(40),
        base_branch: 'main',
        base_sha: 'a'.repeat(40),
        draft: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    available = true
  }
  catch (error) {
    console.warn(`[token-limits] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.pullRequestId) {
        // `review_thread_id`, which is what the foreign key is actually
        // called. Comments first: the constraint refuses a thread that still
        // has any.
        const threadIds = (await db
          .selectFrom('review_threads')
          .select(['id'])
          .where('pull_request_id', '=', created.pullRequestId)
          .execute()).map((row: any) => Number(row.id))

        if (threadIds.length > 0)
          await db.deleteFrom('review_comments').where('review_thread_id', 'in', threadIds).execute()

        await db.deleteFrom('review_threads').where('pull_request_id', '=', created.pullRequestId).execute()
        // The last test submits a review, so there is one of these too.
        await db.deleteFrom('pull_request_reviews').where('pull_request_id', '=', created.pullRequestId).execute()
        await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
      }

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (created.tokenId) {
        await db.deleteFrom('token_usage_windows').where('access_token_id', '=', created.tokenId).execute()
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.tokenId).execute()
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

describe('a token spending its budget', () => {
  test('the first two land and the third is refused', async () => {
    if (!available)
      return

    const first = await comment('one')
    const second = await comment('two')
    const third = await comment('three')

    expect(first.status).toBeLessThan(300)
    expect(second.status).toBeLessThan(300)
    expect(third.status).toBe(429)
  })

  test('the refusal names the limit and when to come back', async () => {
    if (!available)
      return

    /*
     * A bare 429 costs a retry loop that will never succeed at a useful moment.
     * `Retry-After` in the header *and* the body, because a client on a generic
     * HTTP layer reads one and a client written against this API reads the
     * other.
     */
    const refused = await comment('four')

    expect(refused.body?.error?.code).toBe('rate_limited')
    expect(refused.body?.error?.message).toContain('2')
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(refused.headers.get('X-RateLimit-Limit')).toBe('2')
    expect(refused.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  test('and nothing was written by the refused attempts', async () => {
    if (!available)
      return

    // The point of metering before the write. Two comments were asked for
    // twice over and two exist.
    const threads: any[] = await (globalThis as any).db
      .selectFrom('review_threads')
      .select(['id'])
      .where('pull_request_id', '=', created.pullRequestId)
      .execute()

    expect(threads).toHaveLength(2)
  })

  test('a refusal does not extend the lockout', async () => {
    if (!available)
      return

    /*
     * A rejected attempt created nothing, so counting it would let a client
     * that is already being refused push its own window out indefinitely by
     * retrying - the exact behaviour of the loop this is defending against.
     */
    const before: any = await (globalThis as any).db
      .selectFrom('token_usage_windows')
      .select(['used'])
      .where('access_token_id', '=', created.tokenId)
      .where('action', '=', 'comments')
      .executeTakeFirst()

    await comment('five')
    await comment('six')

    const after: any = await (globalThis as any).db
      .selectFrom('token_usage_windows')
      .select(['used'])
      .where('access_token_id', '=', created.tokenId)
      .where('action', '=', 'comments')
      .executeTakeFirst()

    expect(Number(after?.used)).toBe(Number(before?.used))
  })
})

describe('the budgets are separate', () => {
  test('a token out of comments can still submit a review', async () => {
    if (!available)
      return

    /*
     * Three budgets rather than one, because the three cost different amounts
     * of somebody's attention. A linting agent that has used its comment
     * allowance should still be able to say what its verdict was - otherwise
     * the pull request is left with twelve remarks and no conclusion, which is
     * worse than either.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/reviews`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number: 1, state: 'commented', body: 'that is all' }),
    })

    expect(answer.status).not.toBe(429)
  })
})
