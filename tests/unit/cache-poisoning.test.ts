// A fork writes a cache. Can a protected branch be made to execute it?
//
// `workflow-cache-scope.test.ts` covers the rules; this covers the query that
// uses them. The distinction is the whole reason this file exists:
// `docs/ci-security-review.md` scored this gate "Partly - scope is instance-side
// and tested; no adversarial test", and a pure test of `canRestore` passes just
// as happily against a `findRestorable` that forgot to call it.
//
// So these go through the real lookup, against real rows, and ask the question
// from the attacker's end: the entry exists, it is keyed exactly right, and the
// run that wants it is the one that must not have it.
//
// Cache poisoning is the shortest path from "somebody opened a pull request" to
// "code of their choosing ran on the default branch" - by the time a restored
// `node_modules` has a postinstall hook in it, every later check is being run by
// the thing that was meant to catch it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { findRestorable } from '../../app/Actions/Workflow/cache'
import { writableScope } from '../../app/Actions/Workflow/cacheScope'
import type { RunFacts } from '../../app/Actions/Workflow/cacheScope'

const KEY = 'poisontest-deadbeef'

/** The fork's pull request run: untrusted, and the one doing the poisoning. */
const fork: RunFacts = {
  ref: 'refs/pull/41/head',
  defaultBranch: 'main',
  trusted: false,
  pullRequestNumber: 41,
}

/** The default branch, which is what the attack is aimed at. */
const protectedBranch: RunFacts = {
  ref: 'refs/heads/main',
  defaultBranch: 'main',
  trusted: true,
}

/** An ordinary feature branch, which must not read the fork's bytes either. */
const feature: RunFacts = {
  ref: 'refs/heads/feature/thing',
  defaultBranch: 'main',
  trusted: true,
}

describe('a cache a fork wrote', () => {
  let db: any = null
  let repositoryId = 0
  let available = false

  beforeAll(async () => {
    try {
      const { injectGlobalAutoImports } = await import('@stacksjs/server')

      await injectGlobalAutoImports()
      db = (globalThis as any).db

      const handle = `cp${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`

      const owner: any = await db.insertInto('users')
        .values({ name: 'Cache', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      const repository: any = await db.insertInto('repositories').values({
        owner_type: 'user',
        owner_id: Number(owner.id),
        name: `${handle}repo`,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${handle}/${handle}repo.git`,
      }).returning(['id']).executeTakeFirst()

      repositoryId = Number(repository.id)

      /*
       * The poisoned entry, written into the scope a fork run actually gets -
       * taken from `writableScope` rather than spelled out here, so this test
       * keeps attacking the real scope even if its name changes.
       */
      await db.insertInto('workflow_cache_entries').values({
        repository_id: repositoryId,
        scope: writableScope(fork),
        cache_key: KEY,
        label: 'deps-',
        digest: 'a'.repeat(64),
        blob_key: `caches/${repositoryId}/aa/aa/${'a'.repeat(64)}`,
        size_bytes: 1024,
        restores: 0,
      }).execute()

      available = true
    }
    catch (error) {
      console.warn(`[cache-poisoning] skipping: ${error instanceof Error ? error.message : String(error)}`)
      available = false
    }
  }, 120_000)

  afterAll(async () => {
    if (repositoryId)
      await db?.deleteFrom('repositories').where('id', '=', repositoryId).execute().catch(() => null)
  })

  test('is there, so the rest of this file is testing a real row', async () => {
    if (!available)
      return

    /*
     * First, because every assertion below is "this lookup returns nothing" -
     * and a lookup that returns nothing because the row was never written would
     * pass all of them while proving the opposite.
     */
    const hit = await findRestorable(repositoryId, fork, KEY)

    expect(hit).not.toBeNull()
    expect(hit?.scope).toBe(writableScope(fork))
  })

  test('is not restored by the default branch, at the exact key', async () => {
    if (!available)
      return

    // The attack, at its most direct: the entry exists and the key matches.
    expect(await findRestorable(repositoryId, protectedBranch, KEY)).toBeNull()
  })

  test('nor through a prefix fallback, which is the quieter way in', async () => {
    if (!available)
      return

    /*
     * `restore-keys` is a fuzzy match by design - `deps-` finding
     * `deps-abc123` is the ordinary case - and a scope check applied to the
     * exact lookup but not to the fallback would be a hole shaped exactly like
     * this. Worth its own test because the fallback path is the one somebody
     * adds later.
     */
    expect(await findRestorable(repositoryId, protectedBranch, 'no-such-key', ['deps-'])).toBeNull()
    expect(await findRestorable(repositoryId, protectedBranch, 'no-such-key', [''])).toBeNull()
  })

  test('nor by another branch of the same repository', async () => {
    if (!available)
      return

    // Being trusted is not the question. A feature branch is trusted and still
    // has no business executing a stranger's `node_modules`.
    expect(await findRestorable(repositoryId, feature, KEY)).toBeNull()
  })

  test('nor by a second pull request from the same fork', async () => {
    if (!available)
      return

    /*
     * Two pull requests from one fork are two people's code as often as one
     * person's, and a shared scope would be the same poisoning one step further
     * from anybody looking.
     */
    const other: RunFacts = { ...fork, ref: 'refs/pull/42/head', pullRequestNumber: 42 }

    expect(await findRestorable(repositoryId, other, KEY)).toBeNull()
  })

  test('and not by a run that lies about its ref to claim the fork\'s scope', async () => {
    if (!available)
      return

    /*
     * The scope is derived from what the run *is*, on the instance, rather than
     * from anything a runner sends - so a trusted run naming the fork's ref
     * still resolves to a trusted scope and still finds nothing. This is the
     * test that would fail if scope were ever accepted from the client.
     */
    const liar: RunFacts = { ref: 'refs/pull/41/head', defaultBranch: 'main', trusted: true }

    expect(await findRestorable(repositoryId, liar, KEY)).toBeNull()
  })
})
