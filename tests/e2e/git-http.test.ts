// The whole thing, through the real routes, with the real git client.
//
// Everything else in the suite tests a piece: the argument list the routes
// build, the hook script parsing, the permission matrix. This boots the router
// on a port, puts a repository on disk and behind a row, and then runs `git
// clone` and `git push` at it - which is the only way to find out whether the
// pieces agree.
//
// It is here rather than in tests/unit because it needs three things the rest
// of the suite does not: the router, a database, and a listening socket. It
// skips itself, loudly, when the database is not there, so `bun test` on a
// machine with no Postgres still runs everything else.
//
// The most important thing it asks is not "did the clone work" but "which
// repository did it clone". A wire-protocol bug shipped here once that made
// every request operate on the server's own working directory: `git clone`
// succeeded, checked out a real tree, and served the forge's own source for any
// URL. Every assertion below names the repository it expects.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

/** Everything this run created, removed in afterAll however it ends. */
const created = { userId: 0, repositoryId: 0, tokenId: 0, token: '', handle: '', name: '', diskPath: '', temp: '' }

let port = 0
let available = false
/** What git printed for the push, including anything the post-receive hook said. */
let pushOutput = ''
let server: any = null
let hooks = ''

/** A run-unique handle, so two runs cannot collide and neither can a leftover. */
function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Run git, without blocking the event loop.
 *
 * `spawnSync` would be simpler and cannot be used here, which took a while to
 * see: the server under test is running *in this process*, so a synchronous
 * child blocks the loop that has to answer its HTTP requests. `git clone` then
 * sat waiting for a response that could not be written until the clone
 * finished, and failed on its own timeout sixty seconds later. The ref
 * advertisement passed throughout, because that test used `fetch`.
 */
async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean, stdout: string, stderr: string }> {
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
      // git will happily reuse a credential from the system keychain, which
      // makes an "anonymous" request quietly authenticated - and an anonymous
      // test that passes because it was not anonymous is worse than no test.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { ok: code === 0, stdout, stderr }
}

/** The same, for reading the bare repository the tests assert against. */
async function bare(...args: string[]): Promise<string> {
  const result = await git(created.temp, '--git-dir', created.diskPath, ...args)

  return result.stdout.trim()
}

/** The clone URL for the repository this run made. */
function cloneUrl(): string {
  return `http://127.0.0.1:${port}/${created.handle}/${created.name}.git`
}

/**
 * The same URL with a token in it, which is how git carries one.
 *
 * The username is not checked - the token already names its owner - so it is
 * the conventional placeholder.
 */
function authenticatedUrl(): string {
  return `http://x:${created.token}@127.0.0.1:${port}/${created.handle}/${created.name}.git`
}

// Before any app module loads, so the semaphore reads it: the saturation test
// below should refuse in milliseconds, not sit out the production acquire
// timeout. Harmless if another file in the run loaded the module first - the
// test's own timeout covers the slow path too.
process.env.GIT_SEMAPHORE_ACQUIRE_MS = process.env.GIT_SEMAPHORE_ACQUIRE_MS ?? '300'

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-e2e-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()

    // One query decides whether this file can run at all. A missing database is
    // an ordinary state for a checkout to be in, and it must read as "skipped"
    // rather than as fifteen failures.
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { installHooks, useSharedHooks } = await import('../../app/Actions/Git/hooks')

    created.handle = unique('e2e')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({
        name: 'End to end',
        email: `${created.handle}@example.com`,
        handle: created.handle,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    // The hooks go in a directory of this run's own, pointed at this run's
    // port. Installing into the shared directory would repoint every repository
    // on the machine at a server that stops existing when this file finishes.
    hooks = join(created.temp, 'git-hooks')
    const previousUrl = process.env.GIT_HOOK_URL
    process.env.GIT_HOOK_URL = `http://127.0.0.1:${port}`
    await installHooks(hooks)
    process.env.GIT_HOOK_URL = previousUrl
    await useSharedHooks(created.diskPath, hooks)

    // A token to push with. Anonymous read is the point of a public
    // repository; anonymous *write* is not, so an authenticated push needs a
    // credential and this is the one the product issues.
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const issued = generateToken()
    created.token = issued.token

    const tokenRow: any = await (globalThis as any).db
      .insertInto('access_tokens')
      .values({
        user_id: created.userId,
        name: 'end to end',
        prefix: issued.prefix,
        token_hash: issued.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.tokenId = Number(tokenRow?.id)

    await (globalThis as any).db
      .insertInto('access_token_permissions')
      .values({ access_token_id: created.tokenId, scope: 'contents', level: 'write' })
      .execute()

    // Seed it, by pushing over the filesystem rather than over HTTP: the HTTP
    // push is what the tests below are for, and a fixture that depends on the
    // thing under test proves nothing.
    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'seeded.txt'), 'seeded\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'seed')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
// Booting the router, connecting to Postgres and seeding a bare repository do
// not fit in bun's default five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  try {
    // One statement takes the issues, stars and everything else this run made:
    // the foreign keys cascade. It used to need a purge pass first.
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.tokenId) {
      await (globalThis as any).db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.tokenId).execute()
      await (globalThis as any).db.deleteFrom('access_tokens').where('id', '=', created.tokenId).execute()
    }

    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    // And the owner's directory, which the repository was the only thing in.
    // Leaving it behind means a run of this file adds an empty directory to
    // `storage/repos` every time, and after a week the tree is mostly them.
    try {
      removeRepositoryOwnerDirectory(created.diskPath)
    }
    catch { /* somebody else's repository lives there too */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })

  try {
    server?.stop?.(true)
  }
  catch { /* already gone */ }
}, 60_000)

describe('the git wire protocol, end to end', () => {
  test('the server is up and answering', () => {
    if (!available)
      return

    expect(port).toBeGreaterThan(0)
  }, 60_000)

  test('a public repository advertises its refs to a stranger', async () => {
    if (!available)
      return

    const response = await fetch(`${cloneUrl()}/info/refs?service=git-upload-pack`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement')
    expect(body).toContain('# service=git-upload-pack')
    expect(body).toContain('refs/heads/main')
  })

  /**
   * The process ceiling, exercised through the real route. Every heavy slot is
   * held, so the advertisement cannot spawn its git - and the answer has to be
   * a 503 with Retry-After, which git clients surface politely, rather than a
   * request queued without bound.
   */
  test('a saturated heavy class answers 503 with Retry-After', async () => {
    if (!available)
      return

    const { gitSemaphore } = await import('../../app/Actions/Git/semaphore')
    const semaphore = gitSemaphore('heavy')

    const held = await Promise.all(
      Array.from({ length: semaphore.limit }, () => semaphore.acquire()),
    )

    try {
      const response = await fetch(`${cloneUrl()}/info/refs?service=git-upload-pack`)

      expect(response.status).toBe(503)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    finally {
      for (const release of held)
        release?.()
    }
  }, 30_000)

  /**
   * The pack cache, through a real clone.
   *
   * A fleet's expensive operation is fifty identical clones of one commit,
   * each making git walk the graph and compress a pack byte-for-byte
   * identical to the last. The second clone here should be served from the
   * blob store - and, far more importantly, should still be a *correct*
   * clone: the assertion is on the content, not only on the header.
   */
  test('a second identical clone is served from the pack cache, and is still right', async () => {
    if (!available)
      return

    const first = join(created.temp, 'cache-one')
    const one = await git(created.temp, '-c', 'credential.helper=', 'clone', '--quiet', cloneUrl(), first)
    expect(one.ok, one.stderr).toBe(true)

    const second = join(created.temp, 'cache-two')
    const two = await git(created.temp, '-c', 'credential.helper=', 'clone', '--quiet', cloneUrl(), second)
    expect(two.ok, two.stderr).toBe(true)

    // The same commit, the same files. A cache that serves a pack for another
    // repository or another shape would show up here rather than in a header.
    const firstHead = (await git(first, 'rev-parse', 'HEAD')).stdout.trim()
    const secondHead = (await git(second, 'rev-parse', 'HEAD')).stdout.trim()

    expect(secondHead).toBe(firstHead)
    expect((await git(second, 'ls-files')).stdout.trim()).toBe((await git(first, 'ls-files')).stdout.trim())

    // And it really was cached: the store holds a pack for this repository.
    const { blobStore } = await import('../../app/Actions/Git/blobs')
    const store = await blobStore()
    const packs = await store.list(`packs/${created.repositoryId}`)

    expect(packs.length).toBeGreaterThan(0)
  }, 120_000)

  /**
   * Not "did the clone work" but "which repository did it clone". The bug this
   * pins served the forge's own source for every URL, and `git clone` succeeded
   * every time.
   */
  test('cloning gets this repository, with this repository in it', async () => {
    if (!available)
      return

    const into = join(created.temp, 'clone')
    const result = await git(created.temp, '-c', 'credential.helper=', 'clone', '--quiet', cloneUrl(), into)

    expect(result.ok, result.stderr).toBe(true)

    const listed = (await git(into, 'ls-files')).stdout.trim().split('\n')
    expect(listed).toEqual(['seeded.txt'])

    const log = (await git(into, 'log', '-1', '--format=%s')).stdout.trim()
    expect(log).toBe('seed')
  }, 60_000)

  test('pushing over HTTP lands on disk', async () => {
    if (!available)
      return

    const work = join(created.temp, 'clone')
    writeFileSync(join(work, 'pushed.txt'), 'pushed over http\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'pushed over http')

    const pushed = await git(work, '-c', 'credential.helper=', 'push', authenticatedUrl(), 'main')
    expect(pushed.ok, pushed.stderr).toBe(true)

    // Kept for the test below, which asserts on what the *hook* said. git
    // relays the hook's own output through the push, so the sentence explaining
    // a failure is already here - it just has to reach the assertion.
    pushOutput = pushed.stderr

    // Read from the bare repository rather than from the clone: the clone
    // believing it pushed is not the same as the push having landed.
    expect(await bare('log', '-1', '--format=%s', 'main')).toBe('pushed over http')
  })

  /**
   * The end of the chain: git accepted the push, the hook ran, it reached the
   * application, and the application wrote something down. `pushed_at` moving
   * is the one observable that only happens if every link held.
   */
  test('the push reaches the application, not only the disk', async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['pushed_at', 'size_kb'])
      .where('id', '=', created.repositoryId)
      .executeTakeFirst()

    /**
     * The push's own output, as the failure message.
     *
     * `Received: null` says a link in the chain broke and nothing about which,
     * which is a long afternoon. The post-receive hook already prints why it
     * could not record a push - "the forge could not be reached", or the status
     * it got back - and git relays that through the push. So the sentence
     * exists; it just was not reaching whoever reads the failure.
     *
     * The hook allows itself five seconds and never fails a push, both
     * deliberately: git has already accepted the commits by the time it runs.
     * That means a loaded machine can drop the record with no other trace, and
     * this is the trace.
     */
    expect(row?.pushed_at, `pushed_at was not written. The push said:\n${pushOutput || '(nothing)'}`).toBeTruthy()
    expect(Number(row?.size_kb ?? 0), `size_kb was not written. The push said:\n${pushOutput || '(nothing)'}`).toBeGreaterThan(0)
  }, 60_000)

  test('fetching again finds nothing new, which is what a fetch should say', async () => {
    if (!available)
      return

    const fetched = await git(join(created.temp, 'clone'), '-c', 'credential.helper=', 'fetch', 'origin')

    expect(fetched.ok, fetched.stderr).toBe(true)
  }, 60_000)
})

describe('a private repository', () => {
  test('is not clonable by a stranger, and does not confirm it exists', async () => {
    if (!available)
      return

    await (globalThis as any).db
      .updateTable('repositories')
      .set({ visibility: 'private' })
      .where('id', '=', created.repositoryId)
      .execute()

    try {
      const response = await fetch(`${cloneUrl()}/info/refs?service=git-upload-pack`)

      // 404 rather than 401 or 403: telling a stranger they are not allowed to
      // see it confirms there is something to see.
      expect(response.status).toBe(404)

      const into = join(created.temp, 'refused')
      const result = await git(created.temp, '-c', 'credential.helper=', 'clone', '--quiet', cloneUrl(), into)

      expect(result.ok).toBe(false)
    }
    finally {
      await (globalThis as any).db
        .updateTable('repositories')
        .set({ visibility: 'public' })
        .where('id', '=', created.repositoryId)
        .execute()
    }
  }, 60_000)

  test('an anonymous push is refused even when the repository is public', async () => {
    if (!available)
      return

    const work = join(created.temp, 'clone')
    writeFileSync(join(work, 'anonymous.txt'), 'should not land\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'anonymous push')

    const pushed = await git(work, '-c', 'credential.helper=', 'push', 'origin', 'main')

    // Public means readable, not writable. This is the assertion that would
    // have caught a forge where anybody could push to anything.
    expect(pushed.ok).toBe(false)

    expect(await bare('log', '-1', '--format=%s', 'main')).not.toBe('anonymous push')
  }, 60_000)
})

describe('the JSON API, through the same server', () => {
  test('serves a public repository tree to a stranger', async () => {
    if (!available)
      return

    const response = await fetch(
      `http://127.0.0.1:${port}/api/repos/tree?owner=${created.handle}&repository=${created.name}`,
    )
    const body: any = await response.json()

    expect(response.status).toBe(200)
    expect(body.entries.map((entry: any) => entry.name).sort()).toEqual(['pushed.txt', 'seeded.txt'])
  }, 60_000)

  test('answers 404 for a repository nobody has', async () => {
    if (!available)
      return

    const response = await fetch(`http://127.0.0.1:${port}/api/repos/tree?owner=nobody&repository=nothing`)

    expect(response.status).toBe(404)
  }, 60_000)
})

/**
 * A repository big enough that streaming is the difference between working and
 * not.
 *
 * Every other test here would pass against a server that read the whole pack
 * into memory and then wrote it: the seeded repository is three files. The
 * failure that matters shows up on somebody's real repository, at a size where
 * buffering means one clone holds hundreds of megabytes and ten concurrent
 * clones take the process down - and it shows up in production, because a
 * three-file fixture never asked the question.
 *
 * So this pushes and clones something in the megabytes, and checks the two
 * things that separate streaming from buffering:
 *
 * - the response never declares a `Content-Length`, because a server that
 *   knows the length has already built the whole thing
 * - the first bytes arrive well before the last, rather than everything
 *   landing at once at the end
 *
 * The content is random, so nothing delta-compresses it into a pack small
 * enough to make the question moot.
 */
describe('a repository large enough that streaming matters', () => {
  const FILES = 160
  const BYTES_PER_FILE = 48 * 1024
  const TOTAL = FILES * BYTES_PER_FILE

  let headSha = ''
  let bulkWork = ''

  test('accepts a multi-megabyte push', async () => {
    if (!available)
      return

    bulkWork = join(created.temp, 'bulk')
    mkdirSync(bulkWork, { recursive: true })
    await git(bulkWork, 'init', '--quiet')

    for (let index = 0; index < FILES; index++) {
      // getRandomValues caps at 64KB per call, which is why the file size is
      // under it rather than for any reason to do with git.
      const bytes = new Uint8Array(BYTES_PER_FILE)
      crypto.getRandomValues(bytes)
      writeFileSync(join(bulkWork, `blob-${index}.bin`), bytes)
    }

    await git(bulkWork, 'add', '.')
    await git(bulkWork, 'commit', '--quiet', '-m', 'a repository worth streaming')

    const pushed = await git(
      bulkWork, '-c', 'credential.helper=', 'push', authenticatedUrl(), 'HEAD:refs/heads/bulk',
    )
    expect(pushed.ok, pushed.stderr).toBe(true)

    headSha = await bare('rev-parse', 'refs/heads/bulk')
    expect(headSha).toMatch(/^[0-9a-f]{40}$/)
  }, 180_000)

  /**
   * Not "did it clone" but "is every byte the same". A pack that is truncated,
   * or reassembled out of order, still produces a repository git will check
   * out - `git fsck` is what notices, and comparing a file's bytes is what
   * notices if fsck does not.
   */
  test('clones it back byte for byte', async () => {
    if (!available || !headSha)
      return

    const into = join(created.temp, 'bulk-clone')
    const cloned = await git(
      created.temp, '-c', 'credential.helper=', 'clone', '--quiet',
      '--single-branch', '--branch', 'bulk', cloneUrl(), into,
    )
    expect(cloned.ok, cloned.stderr).toBe(true)

    const listed = (await git(into, 'ls-files')).stdout.trim().split('\n')
    expect(listed.length).toBe(FILES)

    const integrity = await git(into, 'fsck', '--no-progress')
    expect(integrity.ok, integrity.stderr).toBe(true)

    // One file compared in full. The tree sha already covers every byte of
    // every file, but a mismatch there says only "something differs".
    const sample = 'blob-99.bin'
    const original = await Bun.file(join(bulkWork, sample)).arrayBuffer()
    const round = await Bun.file(join(into, sample)).arrayBuffer()

    expect(round.byteLength).toBe(original.byteLength)
    expect(Bun.SHA256.hash(round, 'hex')).toBe(Bun.SHA256.hash(original, 'hex'))
  }, 180_000)

  /**
   * The wire, read directly, because `git clone` cannot tell you *how* the
   * bytes arrived.
   *
   * The request is the smallest real upload-pack negotiation there is: one
   * `want`, a flush, and `done`. Each line is pkt-line framed - four hex
   * digits of length, counting the four digits themselves.
   */
  test('streams the pack rather than building it in memory first', async () => {
    if (!available || !headSha)
      return

    const want = `want ${headSha}\n`
    const body = `${(want.length + 4).toString(16).padStart(4, '0')}${want}00000009done\n`

    const started = performance.now()
    /*
     * Measured cold, deliberately.
     *
     * The pack cache serves an identical clone from the blob store, and a
     * cached pack under one read's worth of bytes arrives in a single chunk -
     * which is not the buffering this test exists to catch. Bun reads a file
     * in 256 KB pieces, so a cached pack larger than that still streams; the
     * distinction this asserts is about the *server* building a pack in
     * memory, so the cache is emptied first and git is made to do the work.
     */
    const { blobStore } = await import('../../app/Actions/Git/blobs')
    const packStore = await blobStore()

    for (const entry of await packStore.list(`packs/${created.repositoryId}`))
      await packStore.delete(entry.key)

    const response = await fetch(`${cloneUrl()}/git-upload-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
      body,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-git-upload-pack-result')

    // A server that can state the length has already built the whole pack.
    expect(response.headers.get('content-length')).toBeNull()

    let bytes = 0
    let chunks = 0
    let firstChunkAt = 0
    const reader = response.body!.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break

      if (chunks === 0)
        firstChunkAt = performance.now() - started

      chunks++
      bytes += value.byteLength
    }

    const finishedAt = performance.now() - started

    // The pack really is the size that makes this worth asking about.
    expect(bytes).toBeGreaterThan(TOTAL * 0.8)

    // Arriving in pieces is what streaming is. One chunk carrying everything
    // is what a buffered server produces.
    expect(chunks).toBeGreaterThan(1)

    // And the first piece arrives early rather than with the last. Generous
    // on purpose: this is asking whether the first byte waited for the last,
    // not how fast the machine is.
    expect(firstChunkAt).toBeLessThan(finishedAt * 0.9 + 50)
  }, 180_000)
})

/**
 * Git LFS, through the same server and the same permissions.
 *
 * The protocol is `ts-git-lfs` and is tested there. What is worth testing here
 * is the wiring: that the endpoint is discovered where a client looks for it,
 * that permissions come from the same rule the wire protocol uses, and that the
 * bytes survive a round trip through the real routes.
 */
describe('git LFS, over the same server', () => {
  const lfsUrl = (path: string) => `http://127.0.0.1:${port}/${created.handle}/${created.name}.git/info/lfs${path}`
  const basic = () => `Basic ${btoa(`x:${created.token}`)}`

  // A small object, and the id it is named by.
  const contents = new TextEncoder().encode('a large file, notionally\n')
  let oid = ''

  test('the batch endpoint asks for an object it does not have', async () => {
    if (!available)
      return

    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(contents)
    oid = hasher.digest('hex')

    const response = await fetch(lfsUrl('/objects/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: contents.byteLength }] }),
    })

    expect(response.status).toBe(200)

    const body: any = await response.json()
    expect(body.transfer).toBe('basic')

    // The href has to be one the client can reach, not the path this process
    // sees - it is what git lfs will PUT to next.
    expect(body.objects[0].actions.upload.href).toBe(lfsUrl(`/objects/${oid}`))
    expect(body.objects[0].actions.verify.href).toBe(lfsUrl('/verify'))
  }, 60_000)

  test('the bytes go up, and come back the same', async () => {
    if (!available)
      return

    const put = await fetch(lfsUrl(`/objects/${oid}`), {
      method: 'PUT',
      headers: { Authorization: basic() },
      body: contents,
    })
    expect(put.status).toBe(200)

    const get = await fetch(lfsUrl(`/objects/${oid}`))
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(contents)
  }, 60_000)

  /** Where all the speed of pushing a mostly-existing branch comes from. */
  test('a second batch says nothing about the object it now holds', async () => {
    if (!available)
      return

    const response = await fetch(lfsUrl('/objects/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: contents.byteLength }] }),
    })

    const body: any = await response.json()
    expect(body.objects[0].actions).toBeUndefined()
    expect(body.objects[0].error).toBeUndefined()
  }, 60_000)

  test('verify confirms what arrived', async () => {
    if (!available)
      return

    const response = await fetch(lfsUrl('/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({ oid, size: contents.byteLength }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ oid, size: contents.byteLength })
  }, 60_000)

  /** The store is content-addressed, and the route is what enforces it. */
  test('bytes that do not hash to the id in the URL are refused', async () => {
    if (!available)
      return

    const response = await fetch(lfsUrl(`/objects/${'a'.repeat(64)}`), {
      method: 'PUT',
      headers: { Authorization: basic() },
      body: 'not what was promised',
    })

    expect(response.status).toBe(422)
  }, 60_000)

  /**
   * The wiring that matters most: permissions come from the same rule the wire
   * protocol uses. Anonymous read is the point of a public repository;
   * anonymous write is not.
   *
   * The refusal is **401 with a challenge**, not 403, and this assertion was
   * wrong until a real `git lfs` client was pointed at the server. The client
   * tries anonymously first - it cannot know whether a public repository needs
   * a credential to push to - and it treats 403 as final, so the push failed
   * with "you may not write to this repository" while it was holding a
   * perfectly good token. Every test here sent credentials, so every test
   * passed.
   */
  test('an anonymous client may download, and is asked to authenticate to upload', async () => {
    if (!available)
      return

    const download = await fetch(lfsUrl('/objects/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'download', objects: [{ oid, size: contents.byteLength }] }),
    })
    expect(download.status).toBe(200)

    const upload = await fetch(lfsUrl('/objects/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: contents.byteLength }] }),
    })
    expect(upload.status).toBe(401)
    expect(upload.headers.get('www-authenticate')).toContain('Basic')
  }, 60_000)

  test('locks are taken, listed and released, and survive in the database', async () => {
    if (!available)
      return

    const taken = await fetch(lfsUrl('/locks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({ path: 'design/cover.psd' }),
    })

    expect(taken.status).toBe(201)
    const lock = (await taken.json() as any).lock

    // In the database, not in memory: a lock a deploy forgets is a lock
    // somebody was relying on.
    const stored: any = await (globalThis as any).db
      .selectFrom('repository_lfs_locks')
      .selectAll()
      .where('lock_id', '=', lock.id)
      .executeTakeFirst()

    expect(stored?.path).toBe('design/cover.psd')
    expect(Number(stored?.repository_id)).toBe(created.repositoryId)

    const verified: any = await (await fetch(lfsUrl('/locks/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({}),
    })).json()

    expect(verified.ours.map((entry: any) => entry.path)).toContain('design/cover.psd')
    expect(verified.theirs).toEqual([])

    const released = await fetch(lfsUrl(`/locks/${lock.id}/unlock`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', 'Authorization': basic() },
      body: JSON.stringify({}),
    })

    expect(released.status).toBe(200)
  }, 60_000)

  test('a repository nobody has is a 404, not an empty store', async () => {
    if (!available)
      return

    const response = await fetch(`http://127.0.0.1:${port}/nobody/nothing.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'download', objects: [] }),
    })

    expect(response.status).toBe(404)
  }, 60_000)
})

/**
 * The real `git lfs` client, against the real server.
 *
 * Everything above drives the HTTP surface the way a client is *expected* to.
 * This drives it the way one actually does - discovering the endpoint from the
 * clone URL, negotiating a batch, uploading, and verifying - which is the
 * difference between a server that answers what we think a client asks and one
 * a client is happy with.
 *
 * Skips itself loudly without the client, the same way the file skips without a
 * database.
 */
describe('the git lfs client, end to end', () => {
  let lfsAvailable = false

  beforeAll(async () => {
    if (!available)
      return

    // Opt-in, because spawning the client is what has to be survivable rather
    // than what is being tested. It is a Go binary, and on a host whose swap is
    // exhausted the kernel kills the process group rather than the allocation -
    // taking the whole run down and reporting nothing, which is not a failing
    // test.
    if (process.env.REVIEWOS_LFS_CLIENT_TESTS !== '1') {
      console.warn('[e2e] git lfs client cases skipped: set REVIEWOS_LFS_CLIENT_TESTS=1 to run them')

      return
    }

    const probe = Bun.spawn(['git-lfs', 'version'], { stdout: 'pipe', stderr: 'pipe' })
    lfsAvailable = (await probe.exited) === 0

    if (!lfsAvailable)
      console.warn('[e2e] skipping the git lfs cases: no git-lfs on PATH')
  }, 60_000)

  test('pushes an object, which lands in this repository\'s store', async () => {
    if (!available || !lfsAvailable)
      return

    const work = join(created.temp, 'lfs-work')
    mkdirSync(work, { recursive: true })

    const authenticated = `http://x:${created.token}@127.0.0.1:${port}/${created.handle}/${created.name}.git`

    await git(work, 'init', '--initial-branch=main')
    await git(work, 'lfs', 'install', '--local')
    await git(work, 'lfs', 'track', '*.bin')

    // Random, so nothing compresses it into something small enough that the
    // test would pass without any of this working.
    const payload = new Uint8Array(64 * 1024)
    crypto.getRandomValues(payload)
    writeFileSync(join(work, 'large.bin'), payload)

    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(payload)
    const expectedOid = hasher.digest('hex')

    await git(work, 'add', '.gitattributes', 'large.bin')
    await git(work, 'commit', '-m', 'a large file')

    // The endpoint is discovered from the clone URL, which is the path a real
    // client takes and the one worth testing.
    const pushed = await git(work, '-c', 'credential.helper=', 'push', authenticated, 'main')
    expect(pushed.ok, pushed.stderr).toBe(true)

    // In the store, under the id the client computed independently of us.
    const { storeFor } = await import('../../app/Actions/Git/lfs')
    const stored = await storeFor(created.handle, created.name).lookup(expectedOid)

    expect(stored).toEqual({ oid: expectedOid, size: payload.byteLength })

    // And the commit holds a pointer rather than the bytes: that is the whole
    // point, and it is what a fresh clone will read.
    const committed = await git(work, 'show', 'HEAD:large.bin')
    expect(committed.stdout).toContain('version https://git-lfs.github.com/spec/v1')
    expect(committed.stdout).toContain(`oid sha256:${expectedOid}`)
  }, 180_000)

  test('clones it back, and the bytes are the bytes', async () => {
    if (!available || !lfsAvailable)
      return

    const into = join(created.temp, 'lfs-clone')
    const authenticated = `http://x:${created.token}@127.0.0.1:${port}/${created.handle}/${created.name}.git`

    const cloned = await git(created.temp, '-c', 'credential.helper=', 'clone', '--quiet', authenticated, into)
    expect(cloned.ok, cloned.stderr).toBe(true)

    const original = await Bun.file(join(created.temp, 'lfs-work', 'large.bin')).arrayBuffer()
    const round = await Bun.file(join(into, 'large.bin')).arrayBuffer()

    expect(round.byteLength).toBe(original.byteLength)
    expect(Bun.SHA256.hash(round, 'hex')).toBe(Bun.SHA256.hash(original, 'hex'))
  }, 180_000)
})
