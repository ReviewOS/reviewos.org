// Advancing "last looked" without a verdict, through the real route.
//
// The rule under test is lastSeenHead's: the latest of a submitted review, a
// viewed-file mark, and now the explicit checkpoint wins. The checkpoint is
// the record for the reviewer who read everything and had nothing to add -
// the other two are side effects of doing something, and this one is the
// sentence said on purpose.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly
// when the database is not there. It needs no git: heads here are shas in
// rows, and the diffing they feed is another file's subject.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dbTimestamp } from '../../app/Actions/Support/sql'

const created = {
  reviewerId: 0,
  authorId: 0,
  reviewerToken: '',
  handle: '',
  name: '',
  repositoryId: 0,
  pullRequestId: 0,
}

const HEAD_ONE = '1'.repeat(40)
const HEAD_TWO = '2'.repeat(40)

let available = false
let port = 0
let server: any = null
let lastSeenHead: (pullRequestId: number, reviewerId: number) => Promise<string | null>

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function advance(token: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/last-look`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body: new URLSearchParams({ owner: created.handle, repo: created.name, number: '1' }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    ;({ lastSeenHead } = await import('../../app/Actions/Pull/incremental'))

    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, handle: string, token: string }> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Look Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'advance last look test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const author = await make('all')
    const reviewer = await make('alr')

    created.authorId = author.id
    created.handle = author.handle
    created.reviewerId = reviewer.id
    created.reviewerToken = reviewer.token

    created.name = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: created.name,
        description: 'created by the advance last look end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Advance last look fixture',
        body: '',
        author_id: created.authorId,
        state: 'open',
        head_branch: 'change',
        head_sha: HEAD_ONE,
        base_branch: 'main',
        base_sha: '0'.repeat(40),
        draft: false,
        additions: 0,
        deletions: 0,
        changed_files: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    for (const id of [created.authorId, created.reviewerId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* nothing else to release */ }

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('advancing last looked without a verdict', () => {
  test('a reader with no session cannot catch up as nobody', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/last-look`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ owner: created.handle, repo: created.name, number: '1' }),
    })

    expect(answer.status).toBe(401)
    expect(await lastSeenHead(created.pullRequestId, created.reviewerId)).toBeNull()
  }, 30_000)

  test('the checkpoint records the head as it is now, and last-looked moves', async () => {
    if (!available)
      return

    const { status, body } = await advance(created.reviewerToken)

    expect(status).toBe(200)
    expect(body?.caughtUpTo).toBe(HEAD_ONE)
    expect(await lastSeenHead(created.pullRequestId, created.reviewerId)).toBe(HEAD_ONE)
  }, 30_000)

  test('saying it again after a push is one row moved, not a second row', async () => {
    if (!available)
      return

    // The branch moves; the reviewer catches up again.
    await (globalThis as any).db
      .updateTable('pull_requests')
      .set({ head_sha: HEAD_TWO })
      .where('id', '=', created.pullRequestId)
      .execute()

    const { status, body } = await advance(created.reviewerToken)

    expect(status).toBe(200)
    expect(body?.caughtUpTo).toBe(HEAD_TWO)
    expect(await lastSeenHead(created.pullRequestId, created.reviewerId)).toBe(HEAD_TWO)

    const rows: any[] = await (globalThis as any).db
      .selectFrom('review_checkpoints')
      .select(['id'])
      .where('pull_request_id', '=', created.pullRequestId)
      .where('reviewer_id', '=', created.reviewerId)
      .execute()

    expect(rows.length).toBe(1)
  }, 30_000)

  /**
   * The rule the checkpoint joins, not replaces: the *latest* record wins.
   * A review submitted after the checkpoint is the newer statement of where
   * the reader got to, and the checkpoint must not shadow it.
   */
  test('a review submitted later outranks an earlier checkpoint', async () => {
    if (!available)
      return

    const NEWER = '3'.repeat(40)

    await (globalThis as any).db.insertInto('pull_request_reviews').values({
      pull_request_id: created.pullRequestId,
      reviewer_id: created.reviewerId,
      state: 'commented',
      commit_sha: NEWER,
      body: 'read it again',
      // Clearly after the checkpoint, whatever the test's own timing.
      created_at: dbTimestamp(new Date(Date.now() + 60_000)),
    }).execute()

    expect(await lastSeenHead(created.pullRequestId, created.reviewerId)).toBe(NEWER)
  }, 30_000)
})
