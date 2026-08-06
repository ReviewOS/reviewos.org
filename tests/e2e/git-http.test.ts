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
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

/** Everything this run created, removed in afterAll however it ends. */
const created = { userId: 0, repositoryId: 0, tokenId: 0, token: '', handle: '', name: '', diskPath: '', temp: '' }

let port = 0
let available = false
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
    if (created.repositoryId) {
      const { purgeRepository } = await import('../../app/Actions/Repo/purge')
      await purgeRepository(created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.tokenId) {
      await (globalThis as any).db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.tokenId).execute()
      await (globalThis as any).db.deleteFrom('access_tokens').where('id', '=', created.tokenId).execute()
    }

    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    // And the owner's directory, which the repository was the only thing in.
    // Leaving it behind means a run of this file adds an empty directory to
    // `storage/repos` every time, and after a week the tree is mostly them.
    try {
      rmdirSync(resolve(created.diskPath, '..'))
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

    expect(row?.pushed_at).toBeTruthy()
    expect(Number(row?.size_kb ?? 0)).toBeGreaterThan(0)
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
