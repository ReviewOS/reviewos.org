// This project's own fine-grained tokens, against the JSON API.
//
// The bug this pins: a `ros_` token authenticated git over HTTP and the browse
// endpoints, and every JSON endpoint answered it 401. The credential phase 1
// built could not call the API phase 12 built, which is the parity complaint in
// its purest form - and it was invisible, because the whole e2e suite issues
// framework tokens, which do work.
//
// So these use a real `ros_` token throughout, and assert the three things that
// have to be true together: it authenticates, its grants narrow what it may do,
// and its reach narrows what it can see.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  handle: '',
  /** Reaches everything, may read and write pull requests. */
  wide: '',
  wideId: 0,
  /** Reaches everything, may only read. */
  readOnly: '',
  readOnlyId: 0,
  /** May do anything, but reaches one repository - and not the one below. */
  narrow: '',
  narrowId: 0,
  name: '',
  repositoryId: 0,
  otherName: '',
  otherRepositoryId: 0,
  pullRequestId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function get(path: string, token: string): Promise<number> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  return answer.status
}

async function submitReview(token: string, repo: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/reviews`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ owner: created.handle, repo, number: 1, state: 'commented', body: 'a remark' }),
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

    created.handle = unique('fg')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Token Holder', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const issue = async (selection: string) => {
      const token = generateToken()
      const row: any = await db
        .insertInto('access_tokens')
        .values({
          user_id: created.userId,
          name: `fine grained ${selection}`,
          prefix: token.prefix,
          token_hash: token.hash,
          selection,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .returning(['id'])
        .executeTakeFirst()

      return { token: token.token, id: Number(row?.id) }
    }

    const grant = async (tokenId: number, scope: string, level: string) => {
      await db
        .insertInto('access_token_permissions')
        .values({ access_token_id: tokenId, scope, level })
        .execute()
    }

    const wide = await issue('all')
    created.wide = wide.token
    created.wideId = wide.id
    await grant(wide.id, 'contents', 'read')
    await grant(wide.id, 'pull_requests', 'write')

    const readOnly = await issue('all')
    created.readOnly = readOnly.token
    created.readOnlyId = readOnly.id
    await grant(readOnly.id, 'contents', 'read')
    await grant(readOnly.id, 'pull_requests', 'read')

    const narrow = await issue('selected')
    created.narrow = narrow.token
    created.narrowId = narrow.id
    await grant(narrow.id, 'contents', 'read')
    await grant(narrow.id, 'pull_requests', 'write')

    const makeRepository = async (name: string) => {
      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.userId,
          name,
          // Private, so "can it see this" is a real question rather than one
          // any stranger could answer.
          visibility: 'private',
          default_branch: 'main',
          disk_path: `${created.handle}/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.name = unique('fgrepo')
    created.repositoryId = await makeRepository(created.name)

    created.otherName = unique('fgother')
    created.otherRepositoryId = await makeRepository(created.otherName)

    // The narrow token reaches the *other* repository only.
    await db
      .insertInto('access_token_repositories')
      .values({ access_token_id: created.narrowId, repository_id: created.otherRepositoryId })
      .execute()

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Reachable only with the right token',
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
    console.warn(`[fine-grained-token-api] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.pullRequestId) {
        await db.deleteFrom('pull_request_reviews').where('pull_request_id', '=', created.pullRequestId).execute()
        await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
      }

      const tokens = [created.wideId, created.readOnlyId, created.narrowId].filter(Boolean)
      if (tokens.length > 0) {
        await db.deleteFrom('token_usage_windows').where('access_token_id', 'in', tokens).execute()
        await db.deleteFrom('access_token_repositories').where('access_token_id', 'in', tokens).execute()
        await db.deleteFrom('access_token_permissions').where('access_token_id', 'in', tokens).execute()
      }

      const repositories = [created.repositoryId, created.otherRepositoryId].filter(Boolean)
      if (repositories.length > 0)
        await db.deleteFrom('repositories').where('id', 'in', repositories).execute()

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

describe('authenticating', () => {
  test('a fine-grained token reads a private repository it was granted', async () => {
    if (!available)
      return

    // The whole bug, in one line: this used to be 401.
    const status = await get(
      `/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      created.wide,
    )

    expect(status).toBe(200)
  })

  test('and a token that is not one of ours is still refused', async () => {
    if (!available)
      return

    // The new branch matches on the scheme, so it must not have become a hole
    // that accepts anything shaped roughly like a token.
    const status = await get(
      `/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      'ros_deadbeef_notarealsecret',
    )

    expect(status).toBe(401)
  })
})

describe('the grants narrow it', () => {
  test('a write scope may submit a review', async () => {
    if (!available)
      return

    const { status } = await submitReview(created.wide, created.name)

    expect(status).toBeLessThan(300)
  })

  test('a read-only token may not, and is told which permission is missing', async () => {
    if (!available)
      return

    /*
     * Naming the scope is safe here and only here: the repository is visible
     * and the person behind the token may do it, so the missing piece is the
     * token's own configuration - which is the one thing that turns a 403 into
     * something the holder can fix.
     */
    const { status, body } = await submitReview(created.readOnly, created.name)

    expect(status).toBe(403)
    expect(String(body?.error ?? '')).toContain('pull:review')
  })

  test('but it can still read', async () => {
    if (!available)
      return

    // A token narrows; it does not become useless. This is the difference
    // between fine-grained and "an all-or-nothing token with extra steps".
    const status = await get(
      `/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      created.readOnly,
    )

    expect(status).toBe(200)
  })
})

describe('the reach narrows it', () => {
  test('a repository outside the selection reads as missing, not forbidden', async () => {
    if (!available)
      return

    /*
     * 404 rather than 403, exactly as a stranger sees. "Your token cannot see
     * that one" confirms it exists, and a private repository must not tell
     * anybody that - including the holder of a token that is not scoped to it,
     * because a token is a thing that gets shared.
     */
    const status = await get(
      `/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      created.narrow,
    )

    expect(status).toBe(404)
  })

  test('even though its owner can see it and its grants would allow it', async () => {
    if (!available)
      return

    // Both other dimensions are satisfied - same owner, write on pull requests.
    // Only the reach differs, which is what makes this a test of the reach.
    const allowed = await get(
      `/api/repos/pulls/show?owner=${created.handle}&repo=${created.name}&number=1`,
      created.wide,
    )

    expect(allowed).toBe(200)
  })
})
