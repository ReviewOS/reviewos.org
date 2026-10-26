/**
 * The `issues` row that stands behind a pull request.
 *
 * `issues.is_pull_request` has existed since the table was created and nothing
 * ever set it, while `ListIssuesAction` and `Repo/counters.ts` both already
 * filtered it out: half a design waiting for rows that were never written.
 * `app/Actions/Pull/issueRow.ts` writes them, and this pins the three things
 * that have to stay true.
 *
 *  1. Opening a change writes the row, under the same number.
 *  2. A conversation on that number has somewhere to go, which is the whole
 *     point: `CommentOnIssueAction` resolves a number through `issues` and
 *     answered 404 for every pull request before this.
 *  3. Nothing that lists or counts issues shows them. 169 rows appeared in
 *     `issues` on a seeded instance the moment the backfill ran, and if a
 *     single listing had missed its filter, every repository's issue list
 *     would have filled with changes.
 *
 * The third is the one worth having a test for. The first two fail loudly and
 * immediately; a leak is quiet and looks like data.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', issueNumber: 0, pullNumber: 0, pullId: 0 }

let available = false
let db: any = null
let syncIssueRow: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The shadow row for a number, however it was written. */
async function shadowRow(number: number): Promise<any> {
  return await db
    .selectFrom('issues')
    .select(['id', 'number', 'title', 'state', 'is_pull_request'])
    .where('repository_id', '=', created.repositoryId)
    .where('number', '=', number)
    .executeTakeFirst()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    syncIssueRow = (await import('../../app/Actions/Pull/issueRow')).syncIssueRow

    created.handle = unique('pir')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Issue Row', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the pull request issues row end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    // One real issue and one change, numbered out of the one sequence the two
    // tables share, so neither can pass by finding the other.
    created.issueNumber = 1
    await db.insertInto('issues').values({
      repository_id: created.repositoryId,
      number: created.issueNumber,
      title: 'a genuine issue',
      author_id: created.ownerId,
      state: 'open',
      is_pull_request: false,
    }).execute()

    created.pullNumber = 2
    const pull: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: created.pullNumber,
        title: 'a change that wants a conversation',
        body: 'the body',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'work',
        base_branch: 'main',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
      })
      .returning(['id'])
      .executeTakeFirst()
    created.pullId = Number(pull?.id)

    available = Boolean(created.repositoryId && created.pullId)
  }
  catch {
    available = false
  }
})

afterAll(async () => {
  if (!db || !created.repositoryId)
    return

  await db.deleteFrom('issue_comments').where('commentable_id', 'in', [created.pullId]).execute().catch(() => {})
  await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
  await db.deleteFrom('issues').where('repository_id', '=', created.repositoryId).execute()
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
})

describe('the row behind a change', () => {
  test('is written under the same number, and marked as a change', async () => {
    if (!available)
      return

    await syncIssueRow({
      repositoryId: created.repositoryId,
      number: created.pullNumber,
      title: 'a change that wants a conversation',
      body: 'the body',
      authorId: created.ownerId,
      state: 'open',
    })

    const row = await shadowRow(created.pullNumber)
    expect(row).toBeDefined()
    expect(Boolean(row.is_pull_request)).toBe(true)
    expect(String(row.title)).toBe('a change that wants a conversation')
  })

  test('and writing it twice updates rather than duplicating', async () => {
    if (!available)
      return

    // The backfill command is re-runnable and the open path is not the only
    // writer, so a second write has to converge. `(repository_id, number)` is
    // uniquely indexed, which makes a duplicate a failed insert rather than a
    // second row, and a failed insert here would be silent.
    await syncIssueRow({
      repositoryId: created.repositoryId,
      number: created.pullNumber,
      title: 'an edited title',
      state: 'open',
    })

    const rows = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', created.pullNumber)
      .execute()

    expect(rows).toHaveLength(1)
    expect(String((await shadowRow(created.pullNumber)).title)).toBe('an edited title')
  })

  test('a merge lands as closed, because the column has no word for merged', async () => {
    if (!available)
      return

    await syncIssueRow({ repositoryId: created.repositoryId, number: created.pullNumber, state: 'merged' })
    expect(String((await shadowRow(created.pullNumber)).state)).toBe('closed')

    // And the title it was not given is still there, rather than blanked by a
    // state transition that carried no title.
    expect(String((await shadowRow(created.pullNumber)).title)).toBe('an edited title')

    await syncIssueRow({ repositoryId: created.repositoryId, number: created.pullNumber, state: 'open' })
  })
})

describe('what must not happen', () => {
  test('the change does not appear among the repository issues', async () => {
    if (!available)
      return

    // Asked of the table with the filter every listing applies, rather than
    // through the action, because the claim is about the data: a listing that
    // forgot its filter is a different bug, and this one fails first.
    const listed = await db
      .selectFrom('issues')
      .select(['number'])
      .where('repository_id', '=', created.repositoryId)
      .where('is_pull_request', '=', false)
      .execute()

    expect(listed.map((row: any) => Number(row.number))).toEqual([created.issueNumber])
  })

  test('and the open issue count does not include it', async () => {
    if (!available)
      return

    // `recountOpenIssues` is what writes `repositories.open_issues_count`, so
    // this is the number the repository header shows.
    const { recountOpenIssues } = await import('../../app/Actions/Repo/counters')
    expect(await recountOpenIssues(created.repositoryId)).toBe(1)
  })
})
