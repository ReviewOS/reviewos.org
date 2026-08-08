// A private repository must never appear for somebody without access.
//
// This is the test the roadmap asks for by name, and it is written the
// pessimistic way on purpose: every case feeds the filter a candidate list that
// *already contains* the private repository, as though the index had handed it
// over. That is not a hypothetical - it is the normal state of affairs. Every
// repository is indexed, private ones included, because a maintainer searching
// for their own work is the main thing search is for.
//
// So these tests never assert "the index withheld it". They assert that the
// database-backed check drops it even when the index did not. If somebody later
// adds a `filter_by: visibility:=public` and deletes the check, believing the
// index is doing the work, these fail - which is the whole point, because that
// version passes every test written the optimistic way and leaks the day a
// repository is flipped from public to private and the reindex is thirty
// seconds behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  collaboratorId: 0,
  outsiderId: 0,
  publicId: 0,
  privateId: 0,
  internalId: 0,
  handle: '',
}

let available = false
let db: any
let readableRepositoryIds: typeof import('../../app/Actions/Search/visibility').readableRepositoryIds
let filterToReadable: typeof import('../../app/Actions/Search/visibility').filterToReadable

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Everything the index might hand back, private rows and all. */
function allCandidates(): number[] {
  return [created.publicId, created.privateId, created.internalId]
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
    console.warn(`[search-visibility] skipping, no database: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  ;({ readableRepositoryIds, filterToReadable } = await import('../../app/Actions/Search/visibility'))

  created.handle = unique('sv')

  for (const [key, suffix] of [['ownerId', 'o'], ['collaboratorId', 'c'], ['outsiderId', 'x']] as const) {
    const row: any = await db
      .insertInto('users')
      .values({
        name: `Search visibility ${suffix}`,
        email: `${created.handle}${suffix}@example.com`,
        handle: `${created.handle}${suffix}`,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created[key] = Number(row?.id)
  }

  for (const [key, visibility] of [['publicId', 'public'], ['privateId', 'private'], ['internalId', 'internal']] as const) {
    const name = unique('repo')
    const row: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name,
        description: 'created by the search visibility test',
        visibility,
        default_branch: 'main',
        disk_path: `${created.handle}o/${name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created[key] = Number(row?.id)
  }

  // Read access on the private one, for exactly one person.
  await db
    .insertInto('repo_collaborators')
    .values({ repository_id: created.privateId, user_id: created.collaboratorId, permission: 'read' })
    .execute()
}, 120_000)

afterAll(async () => {
  try {
    const repositories = [created.publicId, created.privateId, created.internalId].filter(Boolean)
    if (db && repositories.length > 0) {
      await db.deleteFrom('repo_collaborators').where('repository_id', 'in', repositories).execute()
      await db.deleteFrom('repositories').where('id', 'in', repositories).execute()
    }

    const users = [created.ownerId, created.collaboratorId, created.outsiderId].filter(Boolean)
    if (db && users.length > 0)
      await db.deleteFrom('users').where('id', 'in', users).execute()
  }
  catch { /* a failed setup leaves less behind than it made */ }
})

describe('the leak case', () => {
  test('a private repository does not reach a signed-in stranger', async () => {
    if (!available)
      return

    // The index handed over all three. Only the check stands between this
    // person and a repository name they are not entitled to know exists.
    const allowed = await readableRepositoryIds(allCandidates(), created.outsiderId)

    expect(allowed.has(created.privateId)).toBe(false)
    expect(allowed.has(created.publicId)).toBe(true)
    // `internal` is deliberately visible to anyone signed in - that is what it
    // is for, per `app/Permissions.ts`. Asserted rather than left out, because
    // the first draft of this test assumed the opposite and would have driven
    // a "fix" that broke the feature to satisfy the test.
    expect(allowed.has(created.internalId)).toBe(true)
  })

  test('nor an anonymous reader', async () => {
    if (!available)
      return

    const allowed = await readableRepositoryIds(allCandidates(), null)

    expect(allowed.has(created.privateId)).toBe(false)
    expect(allowed.has(created.internalId)).toBe(false)
    expect([...allowed]).toEqual([created.publicId])
  })

  test('and the name never survives into the returned hits', async () => {
    if (!available)
      return

    // The same thing asserted one layer up, on the shape a page actually
    // renders. A filter that returns ids correctly and a caller that renders
    // the unfiltered list is the same leak.
    const hits = allCandidates().map(id => ({ repositoryId: id, title: `something in ${id}` }))
    const visible = await filterToReadable(hits, hit => hit.repositoryId, created.outsiderId)

    expect(visible.map(hit => hit.repositoryId)).toEqual([created.publicId, created.internalId])
    expect(JSON.stringify(visible)).not.toContain(String(created.privateId))
  })
})

describe('the people who should see it', () => {
  test('the owner sees all three', async () => {
    if (!available)
      return

    const allowed = await readableRepositoryIds(allCandidates(), created.ownerId)

    expect(allowed.has(created.privateId)).toBe(true)
    expect(allowed.has(created.internalId)).toBe(true)
    expect(allowed.has(created.publicId)).toBe(true)
  })

  test('a collaborator sees the one they were added to', async () => {
    if (!available)
      return

    const allowed = await readableRepositoryIds(allCandidates(), created.collaboratorId)

    expect(allowed.has(created.privateId)).toBe(true)
  })

  test('losing access removes it from results on the very next search', async () => {
    if (!available)
      return

    expect((await readableRepositoryIds(allCandidates(), created.collaboratorId)).has(created.privateId)).toBe(true)

    await db
      .deleteFrom('repo_collaborators')
      .where('repository_id', '=', created.privateId)
      .where('user_id', '=', created.collaboratorId)
      .execute()

    // No reindex, no cache to expire, nothing to invalidate: the check reads
    // the database every time, so revoked access is revoked in search at the
    // same instant it is revoked everywhere else. An index-side filter could
    // not manage this without a job racing the query.
    expect((await readableRepositoryIds(allCandidates(), created.collaboratorId)).has(created.privateId)).toBe(false)

    await db
      .insertInto('repo_collaborators')
      .values({ repository_id: created.privateId, user_id: created.collaboratorId, permission: 'read' })
      .execute()
  })
})

describe('what the filter refuses to assume', () => {
  test('a repository the index knows about and the database does not is dropped', async () => {
    if (!available)
      return

    // The index is a copy, and a copy goes stale. A deleted repository lingers
    // in it until a job catches up, and the reader must not be told it existed.
    const allowed = await readableRepositoryIds([...allCandidates(), 2_147_483_000], created.ownerId)

    expect(allowed.has(2_147_483_000)).toBe(false)
  })

  test('an empty page costs no query and returns nothing', async () => {
    if (!available)
      return

    expect([...await readableRepositoryIds([], created.ownerId)]).toEqual([])
    expect(await filterToReadable([], () => 0, created.ownerId)).toEqual([])
  })

  test('duplicate and junk ids do not widen the answer', async () => {
    if (!available)
      return

    const allowed = await readableRepositoryIds(
      [created.privateId, created.privateId, 0, -1, Number.NaN, created.publicId],
      created.outsiderId,
    )

    expect([...allowed]).toEqual([created.publicId])
    expect(allowed.has(created.privateId)).toBe(false)
  })
})
