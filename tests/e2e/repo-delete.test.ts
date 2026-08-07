/**
 * Deleting a repository takes everything with it, including the rows no
 * foreign key can reach.
 *
 * Needs a database, and skips itself loudly without one, the same way
 * `git-http.test.ts` does - a checkout with no Postgres is an ordinary state to
 * be in and must read as "skipped" rather than as failures.
 *
 * The case this exists for: the cascade removes the issue, and the comment on
 * that issue is polymorphic (`commentable_type` is `issue` or `pull_request`),
 * so no constraint reaches it. That was found by deleting a repository and
 * looking at what was left, which is the only way it can be found.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let available = false
let db: any = null
let sweepPolymorphic: (id: number) => Promise<{ ok: boolean, removed: Array<{ table: string, rows: number }>, error?: string }>
const made: number[] = []
// The user everything here is owned by. Created per run rather than assumed:
// `reactions.user_id` and `notification_subscriptions.user_id` are real foreign
// keys, and a freshly migrated database has no user 1 to point them at.
let userId = 0

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    db = (globalThis as any).db
    await db.selectFrom('repositories').select(['id']).limit(1).execute()

    const handle = `del${Math.floor(Math.random() * 1e9)}`
    const user = await db.insertInto('users')
      .values({ name: 'Delete Tester', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    userId = Number(user.id)

    ;({ sweepPolymorphic } = await import('../../app/Actions/Repo/polymorphic'))
    available = true
  }
  catch (error) {
    console.warn(`[repo-delete] skipping: ${error instanceof Error ? error.message : String(error)}`)
  }
}, 60_000)

afterAll(async () => {
  if (!available)
    return

  for (const id of made)
    await db.deleteFrom('repositories').where('id', '=', id).execute()

  if (userId)
    await db.deleteFrom('users').where('id', '=', userId).execute()
})

/** A repository with one of everything that hangs off it, polymorphic or not. */
async function seedRepository(): Promise<{ id: number, issueId: number, commentId: number }> {
  const name = `delete-test-${Math.floor(Math.random() * 1e9)}`

  const repository = await db.insertInto('repositories')
    .values({
      owner_type: 'user',
      owner_id: userId,
      name,
      description: '',
      visibility: 'public',
      default_branch: 'main',
      disk_path: `x/${name}.git`,
    })
    .returning(['id']).executeTakeFirst()

  const id = Number(repository.id)
  made.push(id)

  const issue = await db.insertInto('issues')
    .values({ repository_id: id, number: 1, title: 'An issue', body: '', state: 'open', is_pull_request: false })
    .returning(['id']).executeTakeFirst()
  const issueId = Number(issue.id)

  const comment = await db.insertInto('issue_comments')
    .values({ commentable_type: 'issue', commentable_id: issueId, body: 'A comment' })
    .returning(['id']).executeTakeFirst()
  const commentId = Number(comment.id)

  await db.insertInto('reactions')
    .values({ subject_type: 'issue_comment', subject_id: commentId, content: '+1', user_id: userId }).execute()
  await db.insertInto('timeline_entries')
    .values({ subject_type: 'issue', subject_id: issueId, kind: 'closed' }).execute()
  await db.insertInto('notification_subscriptions')
    .values({ subject_type: 'repository', subject_id: id, user_id: userId, reason: 'watching' }).execute()
  await db.insertInto('repository_labels')
    .values({ repository_id: id, name: 'bug', color: '#f00', description: '', is_default: true }).execute()

  return { id, issueId, commentId }
}

async function countWhere(table: string, column: string, value: number, and: Record<string, string> = {}): Promise<number> {
  let query = db.selectFrom(table).select(db.fn.count('id').as('n')).where(column, '=', value)

  for (const [key, entry] of Object.entries(and))
    query = query.where(key, '=', entry)

  return Number((await query.executeTakeFirst())?.n ?? 0)
}

describe('deleting a repository', () => {
  test('the constraints take everything a foreign key can reach', async () => {
    if (!available)
      return

    const { id, issueId } = await seedRepository()

    expect(await countWhere('issues', 'repository_id', id)).toBe(1)
    expect(await countWhere('repository_labels', 'repository_id', id)).toBe(1)

    await sweepPolymorphic(id)
    await db.deleteFrom('repositories').where('id', '=', id).execute()

    expect(await countWhere('issues', 'repository_id', id)).toBe(0)
    expect(await countWhere('repository_labels', 'repository_id', id)).toBe(0)
    expect(await countWhere('timeline_entries', 'subject_id', issueId, { subject_type: 'issue' })).toBe(0)
  }, 60_000)

  /**
   * The one that was actually broken. A comment is reached through
   * `commentable_id`, which is an issue on one row and a pull request on the
   * next - so the constraint that would have removed it cannot exist.
   */
  test('the sweep takes the polymorphic rows the constraints cannot', async () => {
    if (!available)
      return

    const { id, issueId, commentId } = await seedRepository()

    expect(await countWhere('issue_comments', 'commentable_id', issueId, { commentable_type: 'issue' })).toBe(1)
    expect(await countWhere('reactions', 'subject_id', commentId, { subject_type: 'issue_comment' })).toBe(1)

    const swept = await sweepPolymorphic(id)
    expect(swept.ok, swept.error).toBe(true)

    expect(await countWhere('issue_comments', 'commentable_id', issueId, { commentable_type: 'issue' })).toBe(0)
    expect(await countWhere('reactions', 'subject_id', commentId, { subject_type: 'issue_comment' })).toBe(0)
    expect(await countWhere('notification_subscriptions', 'subject_id', id, { subject_type: 'repository' })).toBe(0)
  }, 60_000)

  /**
   * The counts go into the audit record, so a number that is not the number of
   * rows removed is a lie in the one place that is supposed to say what
   * happened. `deleteWhereIn` used to return how many ids it had been asked
   * about, which said 2 just as readily when the answer was none.
   */
  test('reports how many rows it removed, not how many it looked for', async () => {
    if (!available)
      return

    const { id } = await seedRepository()
    const swept = await sweepPolymorphic(id)

    const rows = Object.fromEntries(swept.removed.map(entry => [entry.table, entry.rows]))

    expect(rows.issue_comments).toBe(1)
    expect(rows.reactions).toBe(1)
    expect(rows.timeline_entries).toBe(1)
    expect(rows.notification_subscriptions).toBe(1)

    // Nothing muted anything, so the table is absent rather than present at zero.
    expect(swept.removed.some(entry => entry.table === 'notification_mutes')).toBe(false)
  }, 60_000)

  test('a repository id it cannot use is refused rather than guessed at', async () => {
    if (!available)
      return

    for (const bad of [0, -1, Number.NaN])
      expect((await sweepPolymorphic(bad)).ok).toBe(false)
  }, 60_000)
})
