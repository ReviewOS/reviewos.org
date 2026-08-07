// The count on the navigation item, through the real routes.
//
// The badge is the queue's number rendered in the shared layout, and the
// layout is the one place a mistake blanks every page in the product - so
// this file asks the page, not the function, and asks it three ways: with a
// reader who is owed reviews, with a reader who is owed nothing, and with no
// reader at all. The count itself is also asserted directly, because "the
// badge says 1" and "the count excludes drafts and answered requests" are
// different claims and the page only proves the first.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly
// when the database is not there. It needs no git: the badge reads rows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  reviewerId: 0,
  authorId: 0,
  repositoryId: 0,
  reviewerToken: '',
  pullRequestIds: [] as number[],
}

let available = false
let port = 0
let server: any = null
let outstandingRequestCount: (userId: number) => Promise<number>

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, cookieToken?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
  })

  return await answer.text()
}

/** A pull request, with a review request on it, straight into the database. */
async function openPullRequest(options: { number: number, draft?: boolean, responded?: boolean }): Promise<void> {
  const db = (globalThis as any).db

  const row: any = await db
    .insertInto('pull_requests')
    .values({
      repository_id: created.repositoryId,
      number: options.number,
      title: `Badge fixture ${options.number}`,
      body: '',
      author_id: created.authorId,
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

  const id = Number(row?.id)
  created.pullRequestIds.push(id)

  await db.insertInto('pull_request_reviewers').values({
    pull_request_id: id,
    reviewer_type: 'user',
    reviewer_id: created.reviewerId,
    from_code_owners: false,
    responded_at: options.responded ? new Date().toISOString() : null,
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

    ;({ outstandingRequestCount } = await import('../../app/Actions/Pull/queue'))

    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Badge Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.reviewerId = await make('bdr')
    created.authorId = await make('bda')

    const issued: any = await createToken(created.reviewerId, 'review queue badge test')
    created.reviewerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: unique('repo'),
        description: 'created by the review queue badge end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${unique('repo')}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // One request genuinely waiting, one already answered, one on a draft.
    // The badge must say 1, not 3.
    await openPullRequest({ number: 1 })
    await openPullRequest({ number: 2, responded: true })
    await openPullRequest({ number: 3, draft: true })

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    for (const id of [created.reviewerId, created.authorId]) {
      if (id)
        await db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* nothing else to release */ }

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('the count on the navigation item', () => {
  test('excludes what is answered and what is not asking', async () => {
    if (!available)
      return

    // Three requests exist; one is genuinely waiting. An answered request is
    // done, and a draft is not asking - the queue page says that in words,
    // and a badge has no room for the sentence.
    expect(await outstandingRequestCount(created.reviewerId)).toBe(1)
  }, 30_000)

  test('is on the page for the reader it counts', async () => {
    if (!available)
      return

    const html = await fetchPage('/reviews', created.reviewerToken)

    // The class alone would also match the component's stylesheet, which the
    // layout carries whether or not the badge rendered - the markup is the
    // claim, so the markup is what is asked for.
    expect(html).toContain('class="nav-count"')
    expect(html).toContain('1 waiting on you')
  }, 30_000)

  test('is absent when nothing is waiting, rather than a zero', async () => {
    if (!available)
      return

    // The author has no requests. A 0 on the navigation is the forge saying
    // "nothing needs you" every second of the day; silence says it better.
    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.authorId, 'review queue badge test, author')
    const token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    const html = await fetchPage('/reviews', token)

    // The class only, not the phrase: this page says "waiting on you" in its
    // own prose, signed in or not, and the claim here is about the badge.
    expect(html).not.toContain('class="nav-count"')
  }, 30_000)

  test('is absent for a reader with no session', async () => {
    if (!available)
      return

    const html = await fetchPage('/reviews')

    expect(html).not.toContain('class="nav-count"')
  }, 30_000)
})
