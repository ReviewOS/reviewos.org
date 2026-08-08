// A push has to reach the index, and nothing else makes it.
//
// The `useSearch` trait re-indexes when a model is saved, which covers renames
// and description edits. A push is not a model save: `ProcessPushJob` writes
// `pushed_at` with raw SQL on purpose, so no hook fires - and `pushed_at` is the
// field "recently active" sorts by. Without the dispatch this test pins, the
// index keeps whatever timestamp it was built with and the ranking quietly
// stops tracking reality, which is the kind of wrong that never throws.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any
let indexJob: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    available = true
  }
  catch (error) {
    console.warn(`[search-push] skipping, no database: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  indexJob = (await import('../../app/Jobs/IndexRepositoryJob')).default

  created.handle = unique('sp')
  created.name = unique('repo')

  const owner: any = await db
    .insertInto('users')
    .values({ name: 'Push reindex', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()
  created.ownerId = Number(owner?.id)

  const repository: any = await db
    .insertInto('repositories')
    .values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      description: 'before the push',
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
      pushed_at: new Date(Date.parse('2020-01-01T00:00:00.000Z')).toISOString(),
    })
    .returning(['id'])
    .executeTakeFirst()
  created.repositoryId = Number(repository?.id)
}, 120_000)

afterAll(async () => {
  try {
    if (db && created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (db && created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* a failed setup leaves less behind than it made */ }
})

describe('indexing one repository', () => {
  test('writes the document the model would have written', async () => {
    if (!available)
      return

    const result = await indexJob.handle({ repositoryId: created.repositoryId })

    expect(result).toEqual({ indexed: 1, removed: 0 })
  })

  test('carries the new pushed_at, which is what ranking sorts by', async () => {
    if (!available)
      return

    // The push path, as `ProcessPushJob` performs it: raw SQL, no model hook.
    const pushedAt = new Date().toISOString()
    await db
      .updateTable('repositories')
      .set({ pushed_at: pushedAt })
      .where('id', '=', created.repositoryId)
      .execute()

    await indexJob.handle({ repositoryId: created.repositoryId })

    const { repositoryDocuments } = await import('../../app/Actions/Search/documents')
    const row = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'description', 'visibility', 'owner_type', 'owner_id', 'stars_count', 'is_fork', 'is_archived', 'pushed_at', 'updated_at'])
      .where('id', '=', created.repositoryId)
      .executeTakeFirst()

    const [doc] = await repositoryDocuments([row])

    // Seconds, and not the 2020 timestamp the row was created with.
    expect(doc.pushed_at).toBe(Math.floor(Date.parse(pushedAt) / 1000))
    expect(doc.pushed_at).toBeGreaterThan(Math.floor(Date.parse('2021-01-01T00:00:00.000Z') / 1000))
  })

  test('a repository that has been deleted is removed rather than skipped', async () => {
    if (!available)
      return

    // The normal way a delete arrives: the row is gone by the time the queued
    // job runs. An index that skipped this would keep serving the name.
    const result = await indexJob.handle({ repositoryId: 2_147_483_001 })

    expect(result).toEqual({ indexed: 0, removed: 1 })
  })

  test('a full rebuild reaches every repository, not one page of them', async () => {
    if (!available)
      return

    const total = (await db.selectFrom('repositories').select(['id']).execute()).length

    // Paged by id rather than offset, so a small chunk size must still reach
    // the end. An offset walk over a table being written to skips rows.
    // Small enough to need several pages over any real corpus, large enough
    // that the walk is not a few hundred round trips to the search node - which
    // is what a chunk of three became once this instance had a hundred and
    // forty repositories, and it timed out rather than failed.
    const result = await indexJob.handle({ chunkSize: 25 })

    // At least what was there when we counted, not exactly it. The suite runs
    // test files concurrently and several of them create and delete
    // repositories, so an equality here fails for a reason that has nothing to
    // do with paging - which is what it did, only in the full run, only
    // sometimes. The claim being made is that the walk reaches the end rather
    // than stopping after one page of three.
    expect(result.indexed).toBeGreaterThanOrEqual(total)
    expect(result.indexed).toBeGreaterThan(25)
  }, 30_000)
})
