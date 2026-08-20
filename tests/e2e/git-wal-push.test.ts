// A real push, written to the log, and restored from it.
//
// Everything else about the WAL is unit-tested against fixtures. This is the
// question none of that answered, and writing it found two bugs every one of
// those tests had missed:
//
// - `git bundle create` refuses a bare sha ("Refusing to create empty
//   bundle"), because a bundle records *references*. At pre-receive the refs
//   still point at their old values, so the tips have to be parked under
//   temporary refs first. The unit test that "proved" bundling used `--all`,
//   so it proved git works rather than that the push path's arguments do.
// - the child's `close` listener was attached after its stdout was consumed,
//   which races the event. The gate hung, pre-receive timed out, the push was
//   allowed by the documented fail-open rule, and the log stayed empty while
//   every visible part of the push worked perfectly.
//
// Both are the shape this codebase keeps getting caught by, which is why this
// file exists rather than more fixtures.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

/**
 * Remove a directory this test made, and refuse anything else.
 *
 * Written as a guard rather than a bare `rmSync` because the unguarded version
 * of this cleanup destroyed the checkout it was running in: it removed
 * `resolve(diskPath, '..')`, and on the setup-failure path `diskPath` was
 * still the empty string, so that resolved to the *parent of the working
 * directory* and took every sibling project with it.
 *
 * The rules are therefore: never a path derived by walking upwards, never an
 * empty or relative one, and never anything outside a root this test created.
 */
function removeTestDirectory(path: string, allowedRoots: readonly string[]): void {
  if (!path || !path.startsWith('/'))
    return

  const target = resolve(path)

  if (!allowedRoots.some(root => root && target !== resolve(root) && target.startsWith(`${resolve(root)}/`)))
    return

  rmSync(target, { recursive: true, force: true })
}

// Before any app module reads them. The log is off by default, and the store
// writes wherever it is pointed.
process.env.GIT_WAL = 'advisory'

/*
 * The blob root this file points the store at, and the value it has to put
 * back.
 *
 * `bun test` runs every file in one process, so an environment variable set
 * here is set for every file that runs afterwards - and `blobStore()` caches
 * the store it builds the first time anybody asks. Together that meant the
 * artifact suite uploaded its blobs into this test's temporary directory,
 * asserted on `storage/artifacts/...` where nothing had been written, and
 * failed with "a blob another artifact still points at survives its own row
 * expiring" - a sweep bug that was not a sweep bug. Then this file's cleanup
 * deleted the directory those artifacts were in.
 *
 * It passed when either file was run alone, which is why it survived: the two
 * only meet in a full run, and the full run is CI.
 */
const previousBlobRoot = process.env.BLOB_LOCAL_ROOT
process.env.BLOB_LOCAL_ROOT = mkdtempSync(join(tmpdir(), 'reviewos-wal-blobs-'))
// At least sixteen characters, or `hookSecret()` answers null, the gate 404s
// at its own hook, and pre-receive correctly allows the push - leaving a
// perfect push and an empty log.
process.env.GIT_HOOK_SECRET = process.env.GIT_HOOK_SECRET || 'wal-e2e-secret-long-enough-32chars'

const created = { userId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', ownerDirectory: '', temp: '', hooks: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Run git without blocking the loop.
 *
 * `spawnSync` deadlocks here: the server the hook has to reach is running in
 * this process, so a synchronous child holds the loop that would answer it.
 */
async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean, out: string }> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const out = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`
  const code = await child.exited

  return { ok: code === 0, out: out.trim() }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-wal-e2e-'))

  try {
    const { db } = await import('@stacksjs/database')
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    const { route } = await import('@stacksjs/router')

    // `importRoutes()`, not a bare import of the route file: the router only
    // adopts what its own loader collected, so a bare import leaves the POST
    // routes unregistered and the gate answers 405 naming GET and HEAD.
    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)
    process.env.PORT = String(port)

    created.handle = unique('walp')
    created.name = unique('repo')

    const user: any = await db.insertInto('users')
      .values({ name: 'WAL Pusher', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const { repositoryPath, REPOSITORY_ROOT } = await import('../../app/Actions/Git/storage')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!
    // Named explicitly from the handle rather than walked up from the
    // repository path. See `removeTestDirectory`.
    created.ownerDirectory = resolve(REPOSITORY_ROOT, created.handle)

    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { initBare } = await import('../../app/Actions/Git/git')
    const { installHooks, useSharedHooks } = await import('../../app/Actions/Git/hooks')

    mkdirSync(created.ownerDirectory, { recursive: true })
    await initBare(created.diskPath, 'main')

    // A hooks *directory*, pointed at by core.hooksPath - `installHooks` takes
    // the directory, not the repository.
    created.hooks = join(created.temp, 'git-hooks')
    await installHooks(created.hooks)
    await useSharedHooks(created.diskPath, created.hooks)

    available = true
  }
  catch (error) {
    console.warn('[wal-e2e] skipped:', error instanceof Error ? error.message : error)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    server?.stop?.()

    const { db } = await import('@stacksjs/database')

    if (created.repositoryId) {
      await db.deleteFrom('git_wal_entries').where('repository_id', '=', created.repositoryId).execute().catch(() => undefined)
      await db.deleteFrom('git_refs').where('repository_id', '=', created.repositoryId).execute().catch(() => undefined)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch {}

  const { REPOSITORY_ROOT } = await import('../../app/Actions/Git/storage')

  removeTestDirectory(created.temp, [tmpdir()])
  removeTestDirectory(String(process.env.BLOB_LOCAL_ROOT ?? ''), [tmpdir()])

  /*
   * Put the store back before the next file runs.
   *
   * Both halves are needed. Restoring the variable alone leaves the cached
   * store pointing at the directory just deleted, and dropping the cache alone
   * leaves it rebuilt from this file's root. `useBlobStore(null)` makes the
   * next `blobStore()` build a fresh one from the restored environment.
   */
  if (previousBlobRoot === undefined)
    delete process.env.BLOB_LOCAL_ROOT
  else
    process.env.BLOB_LOCAL_ROOT = previousBlobRoot

  const { useBlobStore } = await import('../../app/Actions/Git/blobs')

  useBlobStore(null)
  // Only this test's owner directory, only under the repository root, and only
  // when the handle it was built from is actually set.
  if (created.handle)
    removeTestDirectory(created.ownerDirectory, [resolve(REPOSITORY_ROOT)])
})

describe('a push with the log on', () => {
  test('records an entry whose bundle actually restores the repository', async () => {
    if (!available)
      return

    const work = join(created.temp, 'work')
    mkdirSync(work, { recursive: true })

    await git(work, 'init', '--initial-branch=main')
    await Bun.write(join(work, 'README.md'), '# logged\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the push that gets logged')
    const pushed = await git(work, 'push', created.diskPath, 'main')

    expect(pushed.ok, pushed.out).toBe(true)

    const head = (await git(work, 'rev-parse', 'HEAD')).out

    // Written by the gate before the push was allowed, moved to committed by
    // post-receive once it landed.
    const { entriesFor } = await import('../../app/Actions/Git/wal')
    const entries = await entriesFor(created.repositoryId)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.sequence).toBe(1)
    expect(entries[0]!.status).toBe('committed')
    expect(entries[0]!.updates[0]?.ref).toBe('refs/heads/main')
    expect(entries[0]!.updates[0]?.after).toBe(head)

    // A bundle with a pack in it, not just a header - which is all the
    // bare-sha version ever wrote.
    expect(entries[0]!.blobKey).not.toBeNull()
    expect(entries[0]!.blobBytes).toBeGreaterThan(100)

    const { blobStore } = await import('../../app/Actions/Git/blobs')
    const store = await blobStore()
    const stream = await store.get(entries[0]!.blobKey!)

    expect(stream).not.toBeNull()

    // The claim that makes this a backup: it verifies, and the objects come
    // back into a repository that has never seen them.
    const bundlePath = join(created.temp, 'entry.bundle')
    await Bun.write(bundlePath, await new Response(stream!).arrayBuffer())

    const { initBare, runGit } = await import('../../app/Actions/Git/git')
    const { verifyBundle } = await import('../../app/Actions/Git/wal')

    const restored = join(created.temp, 'restored.git')
    await initBare(restored, 'main')

    const verdict = await verifyBundle(restored, bundlePath)
    expect(verdict.ok, verdict.reason).toBe(true)

    const fetched = await runGit(restored, ['fetch', bundlePath, '+refs/*:refs/*'])
    expect(fetched.ok, fetched.stderr).toBe(true)

    const present = await runGit(restored, ['cat-file', '-e', `${head}^{commit}`])
    expect(present.ok).toBe(true)
  }, 180_000)

  test('leaves no temporary refs behind in the repository', async () => {
    if (!available)
      return

    // The tips are parked under refs/reviewos-wal/* so git has names to
    // bundle, and removed in a finally. One left behind holds objects alive
    // and turns up in somebody's `for-each-ref` as a mystery.
    const { runGit } = await import('../../app/Actions/Git/git')
    const refs = await runGit(created.diskPath, ['for-each-ref', '--format=%(refname)'])

    expect(refs.stdout).not.toContain('refs/reviewos-wal/')
  }, 60_000)

  test('moves the ref ledger, which is what makes disk a cache', async () => {
    if (!available)
      return

    const work = join(created.temp, 'work')
    const head = (await git(work, 'rev-parse', 'HEAD')).out

    // The gate applied the ref transaction to the ledger inside the same
    // request that recorded the log entry.
    const { ledgerFor } = await import('../../app/Actions/Git/refs')
    const ledger = await ledgerFor(created.repositoryId)

    const main = ledger.find(entry => entry.ref === 'refs/heads/main')

    expect(main?.sha).toBe(head)
    // Recorded against the log entry that moved it, which is what tells a
    // materializing node what it still needs.
    expect(main?.sequence).toBeGreaterThan(0)
  }, 60_000)

  test('rebuilds the whole repository from the database and the store', async () => {
    if (!available)
      return

    const work = join(created.temp, 'work')
    const head = (await git(work, 'rev-parse', 'HEAD')).out

    /*
     * The claim phase 18c is actually making: this node can be handed nothing
     * but the ledger and the blob store and produce the repository. Proved by
     * materializing into a path that has never held one.
     */
    const { materialize } = await import('../../app/Actions/Git/materialize')
    const elsewhere = join(created.temp, 'materialized.git')

    const outcome = await materialize(created.repositoryId, elsewhere)

    expect(outcome.ok, outcome.reason ?? '').toBe(true)
    expect(outcome.created).toBe(true)
    expect(outcome.bundlesFetched).toBeGreaterThan(0)

    const { runGit } = await import('../../app/Actions/Git/git')

    // The refs are where the ledger says, and the objects behind them arrived.
    const tip = await runGit(elsewhere, ['rev-parse', 'refs/heads/main'])
    expect(tip.stdout.trim()).toBe(head)

    const commit = await runGit(elsewhere, ['cat-file', '-e', `${head}^{commit}`])
    expect(commit.ok).toBe(true)

    // And it is a repository git will serve, not just a directory of objects.
    const listed = await runGit(elsewhere, ['ls-tree', '--name-only', 'refs/heads/main'])
    expect(listed.stdout).toContain('README.md')
  }, 180_000)

  test('a second push is sequence 2 and carries its own bundle', async () => {
    if (!available)
      return

    const work = join(created.temp, 'work')

    await Bun.write(join(work, 'second.txt'), 'more\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the second push')
    const pushed = await git(work, 'push', created.diskPath, 'main')

    expect(pushed.ok, pushed.out).toBe(true)

    const { entriesFor } = await import('../../app/Actions/Git/wal')
    const entries = await entriesFor(created.repositoryId)

    expect(entries).toHaveLength(2)
    expect(entries[1]!.sequence).toBe(2)
    expect(entries[1]!.blobBytes).toBeGreaterThan(100)
  }, 180_000)
})
