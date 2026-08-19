// Dependency caching against the real tables and the real blob store.
//
// The unit tests hold the two rules - which scope a run may write, and which it
// may read. These hold the things only the database and the store can be wrong
// about: that a snapshot survives the round trip byte for byte, that a second
// upload of the same snapshot is answered as done rather than stored twice, and
// that a fork's entry is not merely marked untrusted but genuinely unreachable
// from a branch of this repository.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const main = { ref: 'refs/heads/main', defaultBranch: 'main', trusted: true }
const feature = { ref: 'refs/heads/feature', defaultBranch: 'main', trusted: true }
const fork = { ref: 'refs/pull/7/head', defaultBranch: 'main', trusted: false, pullRequestNumber: 7 }

const SNAPSHOT = new TextEncoder().encode('a tar of node_modules, as far as this test is concerned')

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(hashed)].map(one => one.toString(16).padStart(2, '0')).join('')
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_cache_entries').select(['id']).limit(1).execute()

    created.handle = unique('cache')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Cache Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)
    available = true
  }
  catch (error) {
    console.warn(`[cache] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!available || !db)
    return

  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => null)
})

describe('a snapshot the default branch wrote', () => {
  test('goes to the store, comes back whole, and is found by a branch that may read it', async () => {
    if (!available)
      return

    const { findRestorable, saveSnapshot } = await import('../../app/Actions/Workflow/cache')
    const { blobStore } = await import('../../app/Actions/Git/blobs')

    const digest = await digestOf(SNAPSHOT)
    const key = unique('key').padEnd(64, '0').slice(0, 64)

    const saved = await saveSnapshot({
      repositoryId: created.repositoryId,
      facts: main,
      cacheKey: key,
      digest,
      sizeBytes: SNAPSHOT.byteLength,
      body: SNAPSHOT,
    })

    expect(saved.ok).toBe(true)
    expect(saved.scope).toBe('refs/heads/main')

    /*
     * A feature branch restoring the default branch's install. This is the case
     * caching exists for: most pull requests change no dependencies, and the
     * fallback is what makes their first job fast.
     */
    const hit = await findRestorable(created.repositoryId, feature, key)

    expect(hit).not.toBeNull()
    expect(hit?.scope).toBe('refs/heads/main')
    // Not the branch's own entry, and the caller is told so - a run view that
    // says "restored from main" is a run view somebody can reason about.
    expect(hit?.exact).toBe(false)

    const store = await blobStore()
    const stream = await store.get(String(hit?.blobKey))
    const bytes = new Uint8Array(await new Response(stream!).arrayBuffer())

    expect(bytes).toEqual(SNAPSHOT)

    await store.delete(String(hit?.blobKey)).catch(() => null)
  }, 120_000)

  test('a second upload of the same snapshot is answered as done, not stored twice', async () => {
    if (!available)
      return

    // At-least-once delivery, so a runner that did not hear the answer sends it
    // again. Treating that as a conflict would make a correct runner retry
    // forever.
    const { saveSnapshot } = await import('../../app/Actions/Workflow/cache')

    const digest = await digestOf(SNAPSHOT)
    const key = unique('key').padEnd(64, '0').slice(0, 64)
    const input = {
      repositoryId: created.repositoryId,
      facts: main,
      cacheKey: key,
      digest,
      sizeBytes: SNAPSHOT.byteLength,
      body: SNAPSHOT,
    }

    expect((await saveSnapshot(input)).duplicate).toBe(false)

    const again = await saveSnapshot(input)

    expect(again.ok).toBe(true)
    expect(again.duplicate).toBe(true)

    const rows = await db
      .selectFrom('workflow_cache_entries')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('cache_key', '=', key)
      .execute()

    expect(rows).toHaveLength(1)
  }, 120_000)
})

describe('a snapshot a fork wrote', () => {
  /**
   * The security boundary, against the real table rather than against the
   * predicate. A fork's entry that is merely *labelled* untrusted and still
   * returned by a lookup is a fork's code running on the default branch.
   */
  test('is not reachable from any branch of this repository', async () => {
    if (!available)
      return

    const { findRestorable, saveSnapshot } = await import('../../app/Actions/Workflow/cache')

    const poison = new TextEncoder().encode('a postinstall hook somebody would rather you did not run')
    const digest = await digestOf(poison)
    const key = unique('key').padEnd(64, '0').slice(0, 64)

    const saved = await saveSnapshot({
      repositoryId: created.repositoryId,
      facts: fork,
      cacheKey: key,
      digest,
      sizeBytes: poison.byteLength,
      body: poison,
    })

    expect(saved.ok).toBe(true)
    // Not a ref, so it cannot collide with one by accident.
    expect(saved.scope).toBe('fork/7')

    expect(await findRestorable(created.repositoryId, main, key)).toBeNull()
    expect(await findRestorable(created.repositoryId, feature, key)).toBeNull()

    // And the fork's own run still gets its cache, because isolation is the
    // point rather than punishment.
    expect((await findRestorable(created.repositoryId, fork, key))?.scope).toBe('fork/7')
  }, 120_000)

  test('cannot write to a scope it names instead of the one it has', async () => {
    if (!available)
      return

    // A runner sends the scope it thinks it has and it is somebody else's
    // program, so the answer is computed from the run row rather than believed.
    const { saveSnapshot } = await import('../../app/Actions/Workflow/cache')

    const refused = await saveSnapshot({
      repositoryId: created.repositoryId,
      facts: fork,
      cacheKey: unique('key').padEnd(64, '0').slice(0, 64),
      digest: await digestOf(SNAPSHOT),
      sizeBytes: SNAPSHOT.byteLength,
      body: SNAPSHOT,
      claimedScope: 'refs/heads/main',
    })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('fork/7')
  }, 120_000)
})

describe('what is refused before the bytes are read', () => {
  test('a snapshot bigger than the ceiling, and a digest that is not one', async () => {
    if (!available)
      return

    const { MAX_SNAPSHOT_BYTES, saveSnapshot } = await import('../../app/Actions/Workflow/cache')

    const base = {
      repositoryId: created.repositoryId,
      facts: main,
      cacheKey: unique('key').padEnd(64, '0').slice(0, 64),
      digest: await digestOf(SNAPSHOT),
      sizeBytes: SNAPSHOT.byteLength,
      body: SNAPSHOT,
    }

    // Above this a cache stops paying: downloading and unpacking is slower than
    // installing from a registry, so a workflow that hits it is one the cache
    // was making worse.
    expect((await saveSnapshot({ ...base, sizeBytes: MAX_SNAPSHOT_BYTES + 1 })).ok).toBe(false)
    expect((await saveSnapshot({ ...base, digest: 'not-a-digest' })).ok).toBe(false)
    expect((await saveSnapshot({ ...base, sizeBytes: 0 })).ok).toBe(false)
  }, 120_000)
})

describe('restoring is recorded', () => {
  test('so collection can prefer an entry that is actually used', async () => {
    if (!available)
      return

    const { findRestorable, markRestored, saveSnapshot } = await import('../../app/Actions/Workflow/cache')

    const key = unique('key').padEnd(64, '0').slice(0, 64)

    await saveSnapshot({
      repositoryId: created.repositoryId,
      facts: main,
      cacheKey: key,
      digest: await digestOf(SNAPSHOT),
      sizeBytes: SNAPSHOT.byteLength,
      body: SNAPSHOT,
    })

    const hit = await findRestorable(created.repositoryId, main, key)
    await markRestored(Number(hit?.id))

    const row: any = await db
      .selectFrom('workflow_cache_entries')
      .select(['restores', 'last_used_at'])
      .where('id', '=', Number(hit?.id))
      .executeTakeFirst()

    // Age measured from the write would drop the entry a hundred runs a day
    // restore in favour of one written this morning and never read.
    expect(Number(row?.restores)).toBe(1)
    expect(row?.last_used_at).toBeTruthy()
  }, 120_000)
})
