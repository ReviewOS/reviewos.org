// The review queue's two queries, against a real database.
//
// The ordering is covered as a pure function in tests/unit/queue.test.ts. This
// file exists for the half that cannot be: two hand-written statements with
// correlated subqueries, which is exactly the shape this codebase has been
// bitten by before. A query that quietly matches nothing returns an empty queue,
// and an empty queue is indistinguishable from having nothing to review - so it
// would look like the feature working, for everybody, forever.
//
// The rule most likely to be got wrong is `responded_at IS NULL`. The row is
// kept when a review lands rather than deleted, so a read that forgets it shows
// a queue that never empties.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  authorId: 0,
  reviewerId: 0,
  otherId: 0,
  repositoryId: 0,
  pullRequestIds: [] as number[],
}

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function makeUser(prefix: string): Promise<number> {
  const handle = unique(prefix)
  const row: any = await (globalThis as any).db
    .insertInto('users')
    .values({ name: 'Queue', email: `${handle}@example.com`, handle, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()

  return Number(row?.id)
}

/** A pull request with one review request on it, and the knobs the order reads. */
async function openPullRequest(options: {
  number: number
  draft?: boolean
  reviewerId?: number
  responded?: boolean
  state?: string
  approvals?: number
}): Promise<number> {
  const db = (globalThis as any).db

  const row: any = await db
    .insertInto('pull_requests')
    .values({
      repository_id: created.repositoryId,
      number: options.number,
      title: `Change ${options.number}`,
      body: 'Opened by the review queue end to end test.',
      author_id: created.authorId,
      state: options.state ?? 'open',
      head_branch: `change-${options.number}`,
      head_sha: 'a'.repeat(40),
      base_branch: 'main',
      base_sha: 'b'.repeat(40),
      draft: options.draft ?? false,
      additions: 1,
      deletions: 1,
      changed_files: 1,
    })
    .returning(['id'])
    .executeTakeFirst()

  const id = Number(row?.id)
  created.pullRequestIds.push(id)

  if (options.reviewerId) {
    await db.insertInto('pull_request_reviewers').values({
      pull_request_id: id,
      reviewer_type: 'user',
      reviewer_id: options.reviewerId,
      from_code_owners: false,
      responded_at: options.responded ? new Date().toISOString() : null,
    }).execute()
  }

  for (let index = 0; index < (options.approvals ?? 0); index += 1) {
    await db.insertInto('pull_request_reviews').values({
      pull_request_id: id,
      reviewer_id: created.otherId,
      state: 'approved',
      body: 'Looks right.',
    }).execute()
  }

  return id
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    created.authorId = await makeUser('qa')
    created.reviewerId = await makeUser('qr')
    created.otherId = await makeUser('qo')

    const owner: any = await (globalThis as any).db
      .selectFrom('users').select(['handle']).where('id', '=', created.authorId).executeTakeFirst()

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: unique('queue'),
        description: 'created by the review queue end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${owner?.handle}/queue.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // 1: waiting on the reviewer. 2: they already answered. 3: somebody else
    // was asked. 4: closed. 5: a draft.
    await openPullRequest({ number: 1, reviewerId: created.reviewerId })
    await openPullRequest({ number: 2, reviewerId: created.reviewerId, responded: true })
    await openPullRequest({ number: 3, reviewerId: created.otherId })
    await openPullRequest({ number: 4, reviewerId: created.reviewerId, state: 'closed' })
    await openPullRequest({ number: 5, reviewerId: created.reviewerId, draft: true })

    available = true
  }
  catch (error) {
    console.warn(`[review-queue] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  for (const id of created.pullRequestIds) {
    await db.deleteFrom('pull_request_reviewers').where('pull_request_id', '=', id).execute()
    await db.deleteFrom('pull_request_reviews').where('pull_request_id', '=', id).execute()
    await db.deleteFrom('pull_requests').where('id', '=', id).execute()
  }

  if (created.repositoryId)
    await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

  for (const id of [created.authorId, created.reviewerId, created.otherId].filter(Boolean))
    await db.deleteFrom('users').where('id', '=', id).execute()
})

describe('the review queue', () => {
  test('names the pull request this person was asked about', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.reviewerId, Date.now())

    expect(queue.waitingOnYou.map(one => one.number)).toContain(1)
  })

  /**
   * The rule most likely to be got wrong. The row is kept when a review lands
   * rather than deleted, so "was this person ever asked" survives - and a read
   * that forgets `responded_at IS NULL` shows a queue that never empties.
   */
  test('a request they already answered is not still waiting on them', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.reviewerId, Date.now())

    expect(queue.waitingOnYou.map(one => one.number)).not.toContain(2)
  })

  test('somebody else\'s request is not in this person\'s queue', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.reviewerId, Date.now())

    expect(queue.waitingOnYou.map(one => one.number)).not.toContain(3)
  })

  test('a closed pull request is nobody\'s problem', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.reviewerId, Date.now())

    expect(queue.waitingOnYou.map(one => one.number)).not.toContain(4)
  })

  /**
   * A draft is listed rather than hidden - it is still somebody's work and
   * still worth finding - and it sorts last, which is what `orderQueue`
   * guarantees and what this checks reaches the caller.
   */
  test('a draft is present and last', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const numbers = (await reviewQueue(created.reviewerId, Date.now())).waitingOnYou.map(one => one.number)

    expect(numbers).toContain(5)
    expect(numbers[numbers.length - 1]).toBe(5)
  })

  test('the author sees what their own pull requests are waiting on', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.authorId, Date.now())

    // 1, 3 and 5 have an outstanding request; 2 was answered and 4 is closed.
    expect(queue.waitingOnOthers.map(one => one.number).sort()).toEqual([1, 3, 5])
  })

  /**
   * One row per pull request, however many people were asked. Two reviewers on
   * one pull request is one thing to read, and a join that returned it twice
   * would make a busy queue look twice as long as it is.
   */
  test('a pull request with two reviewers appears once', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.insertInto('pull_request_reviewers').values({
      pull_request_id: created.pullRequestIds[0],
      reviewer_type: 'user',
      reviewer_id: created.otherId,
      from_code_owners: false,
    }).execute()

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.authorId, Date.now())

    expect(queue.waitingOnOthers.filter(one => one.number === 1)).toHaveLength(1)
    // And the count the order reads is both of them, not one.
    expect(queue.waitingOnOthers.find(one => one.number === 1)?.outstandingReviewers).toBe(2)
  })

  test('somebody with nothing to review has an empty queue, not an error', async () => {
    if (!available)
      return

    const { reviewQueue } = await import('../../app/Actions/Pull/queue')
    const queue = await reviewQueue(created.otherId, Date.now())

    expect(queue.waitingOnOthers).toEqual([])
  })
})
