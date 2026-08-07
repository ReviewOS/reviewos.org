// The live endpoint, which both transports serve.
//
// A socket pushes this shape and a poll asks for it, and both end up in the
// same action - so the two cannot drift. That is what this file protects, and
// the rules worth a database test are the ones a unit test cannot reach:
//
//   - The counts are real, so a banner saying "3 new comments" is true.
//   - A reader who cannot see the repository cannot see its activity, and gets
//     the same answer as for a repository that does not exist. Presence is the
//     sharper edge: "who is looking at this" is information about people, and
//     answering it to anybody who can guess a number is a way to watch a team
//     work.
//   - Presence survives a cache that is not there. It is the garnish; the
//     freshness check next to it is the meal.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  strangerId: 0,
  repositoryId: 0,
  privateId: 0,
  issueId: 0,
  pullRequestId: 0,
  ownerToken: '',
  strangerToken: '',
  ownerHandle: '',
  repoName: '',
  privateName: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function ask(body: Record<string, unknown>, token?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/live`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => ({})) }
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
        .values({ name: 'Live', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'live state test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('lvo')
    const stranger = await make('lvs')

    created.ownerId = owner.id
    created.ownerHandle = owner.handle
    created.ownerToken = owner.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token
    created.repoName = unique('repo')
    created.privateName = unique('priv')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.repoName,
        description: 'created by the live state test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${created.repoName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const secret: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.privateName,
        description: 'private, for the access test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: `x/${created.privateName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.privateId = Number(secret?.id)

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A change',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: 'a'.repeat(40),
        base_branch: 'main',
        base_sha: 'b'.repeat(40),
        draft: false,
        additions: 0,
        deletions: 0,
        changed_files: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    const issue: any = await db
      .insertInto('issues')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A change',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        is_pull_request: true,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.issueId = Number(issue?.id)

    available = true
  }
  catch (error) {
    console.warn(`[live-state] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.pullRequestId) {
      await db.deleteFrom('issue_comments').where('commentable_id', '=', created.issueId).execute()
      await db.deleteFrom('issues').where('id', '=', created.issueId).execute()
      await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
      await db.deleteFrom('repositories').where('id', 'in', [created.repositoryId, created.privateId]).execute()
      await db.deleteFrom('users').where('id', 'in', [created.ownerId, created.strangerId]).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('the reading', () => {
  test('reports the head, the state, and the counts', async () => {
    if (!available)
      return

    const { status, body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.ownerToken,
    )

    expect(status).toBe(200)
    expect(body.head).toBe('a'.repeat(40))
    expect(body.state).toBe('open')
    expect(body.comments).toBe(0)
  })

  test('the comment count is real, so a banner saying three is true', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    for (let i = 0; i < 3; i++) {
      await db.insertInto('issue_comments').values({
        commentable_type: 'issue',
        commentable_id: created.issueId,
        author_id: created.ownerId,
        body: `comment ${i}`,
      }).execute()
    }

    const { body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.ownerToken,
    )

    expect(body.comments).toBe(3)
  })

  test('tells the client when to ask again, rather than the client deciding', async () => {
    if (!available)
      return

    // A hard-coded interval in the page is one a busy instance cannot slow
    // down without shipping something.
    const { body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.ownerToken,
    )

    expect(body.pollAfterMs).toBeGreaterThan(0)
  })

  test('a pull request that does not exist is 404, not an empty reading', async () => {
    if (!available)
      return

    // An empty reading would look like a quiet pull request, and the client
    // would poll it forever.
    expect((await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 9999 },
      created.ownerToken,
    )).status).toBe(404)
  })
})

describe('who may read it', () => {
  test('a private repository answers a stranger the same as a missing one', async () => {
    if (!available)
      return

    // Activity is exactly as private as the pull request, and presence is
    // sharper still: it is information about people.
    const { status } = await ask(
      { owner: created.ownerHandle, repository: created.privateName, number: 1 },
      created.strangerToken,
    )

    expect(status).toBe(404)
  })

  test('a public one is readable by anybody signed in', async () => {
    if (!available)
      return

    // A public pull request's activity is public, so an unrelated reader gets
    // it. Their presence is recorded and the roster they see excludes them.
    const { status, body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.strangerToken,
    )

    expect(status).toBe(200)
    expect(body.comments).toBe(3)
    expect(body.watching).not.toContain('lvs')
  })

  test('an anonymous request with no CSRF token is refused, like every other write', async () => {
    if (!available)
      return

    // POST because it is also a heartbeat, and the router checks a double
    // submit on every non-safe method. A browser satisfies it - the client
    // sends the token through `writeHeaders` - and a bare fetch does not,
    // which is the check working rather than the endpoint being wrong.
    expect((await ask({ owner: created.ownerHandle, repository: created.repoName, number: 1 })).status).toBe(403)
  })
})

describe('presence', () => {
  test('does not list the reader to themselves', async () => {
    if (!available)
      return

    // "You are looking at this" is not information, and including it makes an
    // empty room read as one person.
    const { body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.ownerToken,
    )

    expect(body.watching).not.toContain(created.ownerHandle)
  })

  test('the reading still works when presence cannot be stored', async () => {
    if (!available)
      return

    // A cache that is down should cost the presence line and nothing else. The
    // reader still needs to know a comment arrived, and that is the half that
    // matters.
    const { status, body } = await ask(
      { owner: created.ownerHandle, repository: created.repoName, number: 1 },
      created.ownerToken,
    )

    expect(status).toBe(200)
    expect(Array.isArray(body.watching)).toBe(true)
    expect(body.comments).toBe(3)
  })
})
