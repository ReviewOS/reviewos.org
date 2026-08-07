// The reviewer-load panel on the pull request list, through the real routes.
//
// The panel is maintainer information: who the repository is waiting on, and
// for how long. What this file holds is the reading rules - answered and
// draft requests are not load - the ordering being staleness rather than a
// leaderboard, and the gate: a reader without the maintain rung gets a page
// with no panel on it, not an empty one.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly
// when the database is not there. It needs no git: the panel reads rows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  reviewerId: 0,
  slowId: 0,
  ownerToken: '',
  reviewerToken: '',
  handle: '',
  reviewerHandle: '',
  slowHandle: '',
  name: '',
  repositoryId: 0,
}

let available = false
let port = 0
let server: any = null
let reviewerLoadFor: (repositoryId: number) => Promise<any[]>
let loadPhrase: (row: any, now: number) => string

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(cookieToken?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pulls`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
  })

  return await answer.text()
}

async function openPullRequest(options: {
  number: number
  reviewerId: number
  draft?: boolean
  responded?: boolean
  askedDaysAgo?: number
}): Promise<void> {
  const db = (globalThis as any).db

  const row: any = await db
    .insertInto('pull_requests')
    .values({
      repository_id: created.repositoryId,
      number: options.number,
      title: `Load fixture ${options.number}`,
      body: '',
      author_id: created.ownerId,
      state: 'open',
      head_branch: `change-${options.number}`,
      head_sha: '0'.repeat(40),
      base_branch: 'main',
      base_sha: '1'.repeat(40),
      draft: options.draft ?? false,
      additions: 0,
      deletions: 0,
      changed_files: 0,
    })
    .returning(['id'])
    .executeTakeFirst()

  const asked = new Date(Date.now() - (options.askedDaysAgo ?? 0) * 86_400_000).toISOString()

  await db.insertInto('pull_request_reviewers').values({
    pull_request_id: Number(row?.id),
    reviewer_type: 'user',
    reviewer_id: options.reviewerId,
    from_code_owners: false,
    responded_at: options.responded ? new Date().toISOString() : null,
    created_at: asked,
  }).execute()
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

    ;({ loadPhrase, reviewerLoadFor } = await import('../../app/Actions/Pull/reviewerLoad'))

    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, handle: string, token: string }> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Load Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'reviewer load test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('rlo')
    const reviewer = await make('rlr')
    const slow = await make('rls')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.reviewerId = reviewer.id
    created.reviewerHandle = reviewer.handle
    created.reviewerToken = reviewer.token
    created.slowId = slow.id
    created.slowHandle = slow.handle

    created.name = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the reviewer load end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // The slow reviewer has the stalest request and fewer of them; the busy
    // reviewer has more, asked recently; a draft and an answered request
    // belong to nobody's load.
    await openPullRequest({ number: 1, reviewerId: created.slowId, askedDaysAgo: 9 })
    await openPullRequest({ number: 2, reviewerId: created.reviewerId, askedDaysAgo: 1 })
    await openPullRequest({ number: 3, reviewerId: created.reviewerId, askedDaysAgo: 2 })
    await openPullRequest({ number: 4, reviewerId: created.reviewerId, responded: true })
    await openPullRequest({ number: 5, reviewerId: created.reviewerId, draft: true })

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

    for (const id of [created.ownerId, created.reviewerId, created.slowId]) {
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

describe('reviewer load on the pull request list', () => {
  test('counts what is genuinely waiting, and orders by staleness', async () => {
    if (!available)
      return

    const rows = await reviewerLoadFor(created.repositoryId)

    // The slow reviewer first: nine days beats two, whatever the counts say.
    expect(rows.map((row: any) => row.handle)).toEqual([created.slowHandle, created.reviewerHandle])

    // The answered request and the draft are nobody's load.
    expect(rows.find((row: any) => row.handle === created.reviewerHandle)?.waiting).toBe(2)
    expect(rows.find((row: any) => row.handle === created.slowHandle)?.waiting).toBe(1)
  }, 30_000)

  test('says each row as a phrase, in the queue’s own words', async () => {
    if (!available)
      return

    const rows = await reviewerLoadFor(created.repositoryId)
    const slow = rows.find((row: any) => row.handle === created.slowHandle)

    expect(loadPhrase(slow, Date.now())).toBe('1 waiting, oldest 9d')
  }, 30_000)

  test('the maintainer sees the panel', async () => {
    if (!available)
      return

    const html = await fetchPage(created.ownerToken)

    expect(html).toContain('Waiting on reviewers')
    expect(html).toContain(created.slowHandle)
    expect(html).toContain('oldest 9d')
  }, 30_000)

  test('a reader without the maintain rung gets a page with no panel on it', async () => {
    if (!available)
      return

    const signedIn = await fetchPage(created.reviewerToken)
    const anonymous = await fetchPage()

    expect(signedIn).not.toContain('Waiting on reviewers')
    expect(anonymous).not.toContain('Waiting on reviewers')
  }, 30_000)
})
