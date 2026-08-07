// A reviewer's progress, through the real routes.
//
// The claim is that where somebody got to in a review follows them between
// machines, and the only way to check it is to ask the server rather than the
// browser: local storage would answer yes to every one of these tests while
// storing nothing anybody else could ever read.
//
// The cases that matter are the ones with a wrong answer that looks right. A
// viewed set that is not scoped to the reader ticks boxes - just everybody's,
// on everybody's behalf. An endpoint that answers 200 to a stranger for a
// private repository leaks the fact that it exists. And a draft stored without
// its anchor comes back as a comment about code it is not about.
//
// Like the rest of tests/e2e this needs the router, a database and a socket,
// and skips itself loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/** Everything this run created, removed in afterAll however it ends. */
const created = {
  reviewerId: 0,
  strangerId: 0,
  repositoryId: 0,
  privateRepositoryId: 0,
  pullRequestId: 0,
  privatePullRequestId: 0,
  handle: '',
  name: '',
  privateName: '',
  reviewerToken: '',
  strangerToken: '',
}

let port = 0
let available = false
let server: any = null

/** A run-unique handle, so two runs cannot collide and neither can a leftover. */
function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The query every one of these endpoints is addressed by. */
function query(name = created.name, number = 1): string {
  return `owner=${created.handle}&repo=${name}&number=${number}`
}

async function get(path: string, token?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** The same read, with the credential a browser actually carries. */
async function getWithCookie(path: string, token: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Cookie: `auth-token=${token}` },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function put(path: string, form: Record<string, string>, token?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: new URLSearchParams(form),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function makeUser(prefix: string): Promise<{ id: number, token: string }> {
  const handle = unique(prefix)

  const row: any = await (globalThis as any).db
    .insertInto('users')
    .values({ name: 'Review State', email: `${handle}@example.com`, handle, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()

  const id = Number(row?.id)
  const { createToken } = await import('@stacksjs/auth')
  const issued: any = await createToken(id, 'review state test')

  return { id, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
}

async function makePullRequest(repositoryId: number, authorId: number): Promise<number> {
  const row: any = await (globalThis as any).db
    .insertInto('pull_requests')
    .values({
      repository_id: repositoryId,
      number: 1,
      title: 'Something to review',
      body: 'Opened by the review state end to end test.',
      author_id: authorId,
      state: 'open',
      head_branch: 'change',
      head_sha: 'a'.repeat(40),
      base_branch: 'main',
      base_sha: 'b'.repeat(40),
      draft: false,
      additions: 1,
      deletions: 1,
      changed_files: 1,
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(row?.id)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()

    // One query decides whether this file can run at all. A missing database is
    // an ordinary state for a checkout to be in and must read as "skipped".
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const reviewer = await makeUser('rev')
    const stranger = await makeUser('str')

    created.reviewerId = reviewer.id
    created.reviewerToken = reviewer.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token

    // The reviewer owns both repositories, so the private one is private to the
    // stranger and to nobody else - which is the shape the leak would hide in.
    const owner: any = await (globalThis as any).db
      .selectFrom('users')
      .select(['handle'])
      .where('id', '=', created.reviewerId)
      .executeTakeFirst()

    created.handle = String(owner?.handle)
    created.name = unique('repo')
    created.privateName = unique('secret')

    for (const [name, visibility] of [[created.name, 'public'], [created.privateName, 'private']] as const) {
      const repository: any = await (globalThis as any).db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.reviewerId,
          name,
          description: 'created by the review state end to end test',
          visibility,
          default_branch: 'main',
          disk_path: `${created.handle}/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      if (visibility === 'public')
        created.repositoryId = Number(repository?.id)
      else
        created.privateRepositoryId = Number(repository?.id)
    }

    created.pullRequestId = await makePullRequest(created.repositoryId, created.reviewerId)
    created.privatePullRequestId = await makePullRequest(created.privateRepositoryId, created.reviewerId)

    available = true
  }
  catch (error) {
    console.warn(`[review-state] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    for (const id of [created.pullRequestId, created.privatePullRequestId].filter(Boolean)) {
      await db.deleteFrom('reviewed_files').where('pull_request_id', '=', id).execute()
      await db.deleteFrom('review_drafts').where('pull_request_id', '=', id).execute()
      await db.deleteFrom('pull_requests').where('id', '=', id).execute()
    }

    for (const id of [created.repositoryId, created.privateRepositoryId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute()

    for (const id of [created.reviewerId, created.strangerId].filter(Boolean)) {
      await db.deleteFrom('personal_access_tokens').where('user_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  finally {
    server?.stop?.()
  }
})

describe('viewed files', () => {
  test('a tick is there on the way back', async () => {
    if (!available)
      return

    const marked = await put(`/api/repos/pulls/review-state/viewed?${query()}`, {
      path: 'src/a.ts',
      viewed: 'true',
    }, created.reviewerToken)

    expect(marked.status).toBe(200)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)

    expect(state.status).toBe(200)
    expect(state.body.signed_in).toBe(true)
    expect(state.body.viewed.map((one: any) => one.path)).toEqual(['src/a.ts'])
  })

  /**
   * Ticking twice is one row, not two. The unique index is what enforces it,
   * and without the upsert behind these endpoints the second request would fail
   * on it - which a reviewer with the same pull request open in two tabs would
   * find immediately.
   */
  test('ticking the same file twice is still one file', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'src/a.ts' }, created.reviewerToken)
    const again = await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'src/a.ts' }, created.reviewerToken)

    expect(again.status).toBe(200)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)
    expect(state.body.viewed).toHaveLength(1)
  })

  test('unticking removes it rather than leaving it behind', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'src/b.ts' }, created.reviewerToken)
    await put(`/api/repos/pulls/review-state/viewed?${query()}`, {
      path: 'src/b.ts',
      viewed: 'false',
    }, created.reviewerToken)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)
    expect(state.body.viewed.map((one: any) => one.path)).not.toContain('src/b.ts')
  })

  /**
   * The claim the whole feature rests on. Not "a tick is stored" - a tick is
   * stored *against one person*, and somebody else reading the same pull
   * request sees their own progress and not this one's.
   */
  test('one reader\'s progress is not another\'s', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'src/a.ts' }, created.reviewerToken)

    const theirs = await get(`/api/repos/pulls/review-state?${query()}`, created.strangerToken)

    expect(theirs.status).toBe(200)
    expect(theirs.body.signed_in).toBe(true)
    expect(theirs.body.viewed).toEqual([])
  })

  test('a file needs a name', async () => {
    if (!available)
      return

    const refused = await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: '  ' }, created.reviewerToken)
    expect(refused.status).toBe(422)
  })
})

describe('drafts', () => {
  const draft = { path: 'src/a.ts', side: 'left', from_line: '4', to_line: '7', body: 'half a thought' }

  test('comes back with the anchor it was written against, not just the words', async () => {
    if (!available)
      return

    const saved = await put(`/api/repos/pulls/review-state/draft?${query()}`, draft, created.reviewerToken)
    expect(saved.status).toBe(200)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)

    expect(state.body.draft).toEqual({
      path: 'src/a.ts',
      side: 'left',
      from: 4,
      to: 7,
      text: 'half a thought',
    })
  })

  test('a second draft replaces the first, because the viewer only has one', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/draft?${query()}`, draft, created.reviewerToken)
    await put(`/api/repos/pulls/review-state/draft?${query()}`, {
      ...draft,
      path: 'src/c.ts',
      body: 'a different thought',
    }, created.reviewerToken)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)

    expect(state.body.draft.path).toBe('src/c.ts')
    expect(state.body.draft.text).toBe('a different thought')
  })

  test('an empty body discards it, which is what sending the comment does', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/draft?${query()}`, draft, created.reviewerToken)
    const cleared = await put(`/api/repos/pulls/review-state/draft?${query()}`, {
      ...draft,
      body: '',
    }, created.reviewerToken)

    expect(cleared.status).toBe(200)

    const state = await get(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)
    expect(state.body.draft).toBeNull()
  })

  test('a range that ends above where it starts is refused', async () => {
    if (!available)
      return

    const refused = await put(`/api/repos/pulls/review-state/draft?${query()}`, {
      ...draft,
      from_line: '9',
      to_line: '2',
    }, created.reviewerToken)

    expect(refused.status).toBe(422)
  })

  test('a draft with no line to sit on is refused rather than stored', async () => {
    if (!available)
      return

    const refused = await put(`/api/repos/pulls/review-state/draft?${query()}`, {
      path: 'src/a.ts',
      side: 'right',
      body: 'words with nowhere to go',
    }, created.reviewerToken)

    expect(refused.status).toBe(422)
  })
})

describe('who may ask', () => {
  /**
   * A signed-out reader is answered rather than refused. The page still works
   * for them - the browser keeps their progress in local storage - and a 401
   * here would be a failed request on every load of a public pull request.
   */
  test('a signed-out reader gets an empty answer, not a refusal', async () => {
    if (!available)
      return

    const state = await get(`/api/repos/pulls/review-state?${query()}`)

    expect(state.status).toBe(200)
    expect(state.body.signed_in).toBe(false)
    expect(state.body.viewed).toEqual([])
    expect(state.body.draft).toBeNull()
  })

  /**
   * The credential a browser has, which is not the one the tests reach for.
   *
   * A page signs somebody in with a cookie, and a `fetch` from that page sends
   * it automatically and sends no `Authorization` header at all. This route
   * carries no auth middleware on purpose, so before `currentUser` learned to
   * read the cookie it saw a stranger and answered `signed_in: false` to every
   * signed-in reader - and their progress would never have come back on any
   * machine, on a request that answered 200 the whole time.
   *
   * A bearer token passes this test whether or not the bug is there, which is
   * exactly why the cookie is asked for separately.
   */
  test('a cookie is a signature too, and this route has no middleware to read it', async () => {
    if (!available)
      return

    await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'cookie.ts' }, created.reviewerToken)

    const state = await getWithCookie(`/api/repos/pulls/review-state?${query()}`, created.reviewerToken)

    expect(state.status).toBe(200)
    expect(state.body.signed_in).toBe(true)
    expect(state.body.viewed.map((one: any) => one.path)).toContain('cookie.ts')
  })

  test('a signed-out reader cannot record anything', async () => {
    if (!available)
      return

    const refused = await put(`/api/repos/pulls/review-state/viewed?${query()}`, { path: 'src/a.ts' })
    expect(refused.status).toBe(401)
  })

  /**
   * Reported as missing rather than forbidden. "You are not allowed to see
   * this" confirms it exists, which is the one thing a private repository must
   * not tell a stranger.
   */
  test('a private repository is not there at all, to somebody who cannot read it', async () => {
    if (!available)
      return

    const state = await get(`/api/repos/pulls/review-state?${query(created.privateName)}`, created.strangerToken)
    expect(state.status).toBe(404)

    const marked = await put(
      `/api/repos/pulls/review-state/viewed?${query(created.privateName)}`,
      { path: 'src/a.ts' },
      created.strangerToken,
    )
    expect(marked.status).toBe(404)
  })

  test('its owner reads it perfectly well', async () => {
    if (!available)
      return

    const state = await get(`/api/repos/pulls/review-state?${query(created.privateName)}`, created.reviewerToken)
    expect(state.status).toBe(200)
    expect(state.body.signed_in).toBe(true)
  })

  test('a pull request number from another repository is not this one\'s', async () => {
    if (!available)
      return

    const state = await get(`/api/repos/pulls/review-state?${query(created.name, 9999)}`, created.reviewerToken)
    expect(state.status).toBe(404)
  })
})
