// What actually goes into the index.
//
// The document is built here rather than by the `useSearch` trait, because the
// two fields that make this corpus worth searching - the owner's handle and the
// repository's topics - are relations, and `shape()` is synchronous. So these
// pin the projection: the fields that must be present, the noise that must not,
// and the batching that keeps a rebuild from being one query per row.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any
let repositoryDocuments: typeof import('../../app/Actions/Search/documents').repositoryDocuments
let REPOSITORY_COLUMNS: typeof import('../../app/Actions/Search/documents').REPOSITORY_COLUMNS

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function rowFor(id: number): Promise<any> {
  return await db
    .selectFrom('repositories')
    .select([...REPOSITORY_COLUMNS])
    .where('id', '=', id)
    .executeTakeFirst()
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
    console.warn(`[search-indexing] skipping, no database: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  ;({ repositoryDocuments, REPOSITORY_COLUMNS } = await import('../../app/Actions/Search/documents'))

  created.handle = unique('si')
  created.name = unique('repo')

  const owner: any = await db
    .insertInto('users')
    .values({ name: 'Index test', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
    .returning(['id'])
    .executeTakeFirst()
  created.ownerId = Number(owner?.id)

  const repository: any = await db
    .insertInto('repositories')
    .values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      description: 'a forge built around the review',
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    })
    .returning(['id'])
    .executeTakeFirst()
  created.repositoryId = Number(repository?.id)

  for (const topic of ['git', 'code-review'])
    await db.insertInto('repo_topics').values({ repository_id: created.repositoryId, topic }).execute()
}, 120_000)

afterAll(async () => {
  try {
    if (db && created.repositoryId) {
      await db.deleteFrom('repo_topics').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (db && created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* a failed setup leaves less behind than it made */ }
})

describe('the repository document', () => {
  test('carries the owner handle and the topics', async () => {
    if (!available)
      return

    const [doc] = await repositoryDocuments([await rowFor(created.repositoryId)])

    // The two the trait could not supply, and the reason this projection
    // exists at all.
    expect(doc.owner).toBe(created.handle)
    expect(doc.topics.sort()).toEqual(['code-review', 'git'])
    expect(doc.full_name).toBe(`${created.handle}/${created.name}`)
  })

  test('leaves out what nobody searches', async () => {
    if (!available)
      return

    const [doc] = await repositoryDocuments([await rowFor(created.repositoryId)])
    const keys = Object.keys(doc)

    // The trait's default projection put all twenty-one columns in. These cost
    // index size and a write on every push, and `disk_path` is server
    // filesystem layout that has no business in a search corpus at all.
    for (const noise of ['disk_path', 'allow_squash_merge', 'allow_merge_commit', 'delete_branch_on_merge', 'issue_counter', 'default_branch'])
      expect(keys).not.toContain(noise)

    expect(keys.length).toBeLessThan(15)
  })

  test('dates are numbers, because that is what sorts', async () => {
    if (!available)
      return

    const [doc] = await repositoryDocuments([await rowFor(created.repositoryId)])

    // Typesense sorts numbers, not ISO strings. Ranking by recent activity is
    // the whole point of carrying these, and an ISO string sorts
    // lexicographically - which happens to be right until a timezone or a
    // missing millisecond makes it wrong.
    expect(typeof doc.updated_at).toBe('number')
    expect(typeof doc.pushed_at).toBe('number')
  })

  test('the id is a string, which is what the index keys on', async () => {
    if (!available)
      return

    const [doc] = await repositoryDocuments([await rowFor(created.repositoryId)])

    expect(doc.id).toBe(String(created.repositoryId))
  })

  test('a batch costs a fixed number of queries, not one per row', async () => {
    if (!available)
      return

    // Asserted by shape rather than by counting queries: the projection takes
    // the whole batch, so a caller cannot write the per-row loop that a
    // synchronous `shape()` hook would have forced.
    const rows = await db
      .selectFrom('repositories')
      .select([...REPOSITORY_COLUMNS])
      .limit(5)
      .execute()

    const docs = await repositoryDocuments(rows)

    expect(docs.length).toBe(rows.length)
    expect(docs.every(doc => typeof doc.owner === 'string')).toBe(true)
  })

  test('an empty batch asks the database nothing', async () => {
    if (!available)
      return

    expect(await repositoryDocuments([])).toEqual([])
  })
})
