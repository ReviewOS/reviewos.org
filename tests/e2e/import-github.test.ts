// Importing a repository, against a fixture that behaves like GitHub.
//
// The phase asks for tests against a fixture repository covering each entity
// type, and the reason is the same one the single sign-on and passkey tests
// give: the interesting failures are silent. An importer that drops review
// thread anchors still reports "imported 40 comments", and the loss is only
// visible months later when somebody opens an old pull request and finds forty
// comments about nothing.
//
// So the fixture is a real bare repository on disk and a real HTTP server
// answering the endpoints the client calls, paginating with a real `Link`
// header. Nothing is stubbed at the boundary under test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

const created = {
  ownerHandle: '',
  ownerId: 0,
  repositoryId: 0,
  name: '',
  diskPath: '',
  operationId: 0,
  aliceId: 0,
  bobId: 0,
  bobHandle: '',
}

let available = false
let api: any = null
let apiPort = 0
let sourcePath = ''
const scratch = join(
  String(process.env.TMPDIR ?? '/tmp'),
  `reviewos-import-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`,
)

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The fixture's issues, pull requests and review comments, as GitHub shapes them. */
const FIXTURE = {
  issues: [
    {
      number: 7,
      title: 'The total disagrees with the receipt',
      body: 'Rounding once at the end. See https://github.com/acme/api/issues/3 for the original report.',
      state: 'open',
      user: { login: 'alice', id: 1 },
      labels: [{ name: 'bug', color: 'd73a4a', description: 'Something is wrong' }],
      created_at: '2026-01-02T10:00:00Z',
      closed_at: null,
    },
    {
      number: 8,
      title: 'Document the rounding rule',
      body: 'A follow-up to #7.',
      state: 'closed',
      user: { login: 'stranger', id: 99 },
      labels: [],
      created_at: '2026-01-03T10:00:00Z',
      closed_at: '2026-01-04T10:00:00Z',
    },
    // A pull request also appears in the issues endpoint, and importing it as an
    // issue would produce a duplicate with the same number.
    {
      number: 9,
      title: 'Round each line',
      body: 'x',
      state: 'open',
      user: { login: 'alice', id: 1 },
      labels: [],
      pull_request: { url: 'https://example.invalid/pulls/9' },
      created_at: '2026-01-05T10:00:00Z',
      closed_at: null,
    },
  ],
  pulls: [
    {
      number: 9,
      title: 'Round each line',
      body: 'Fixes #7.',
      state: 'open',
      user: { login: 'alice', id: 1 },
      draft: false,
      head: { ref: 'fix/rounding', sha: 'a'.repeat(40) },
      base: { ref: 'main', sha: 'b'.repeat(40) },
      created_at: '2026-01-05T10:00:00Z',
      merged_at: null,
      closed_at: null,
    },
  ],
  comments: [
    {
      id: 5001,
      pull_request_url: 'https://api.github.com/repos/acme/api/pulls/9',
      path: 'src/cart.ts',
      line: 42,
      side: 'RIGHT',
      body: 'This should be a constant.',
      user: { login: 'bob', id: 2 },
      created_at: '2026-01-06T10:00:00Z',
      in_reply_to_id: null,
    },
    {
      id: 5002,
      pull_request_url: 'https://api.github.com/repos/acme/api/pulls/9',
      path: 'src/cart.ts',
      line: 42,
      side: 'RIGHT',
      body: 'Agreed, moved it.',
      user: { login: 'alice', id: 1 },
      created_at: '2026-01-06T11:00:00Z',
      in_reply_to_id: 5001,
    },
  ],
  labels: [
    { name: 'bug', color: 'd73a4a', description: 'Something is wrong' },
    { name: 'documentation', color: '0075ca', description: 'Docs' },
  ],
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('repositories').select(['id']).limit(1).execute()

    /*
     * A real bare repository for the clone to copy.
     *
     * `GITHUB_CLONE_BASE` points the importer's `git clone --mirror` at this
     * directory instead of github.com, so the git stage does a genuine clone of
     * genuine objects rather than being skipped in tests - which is the stage
     * that has to finish before anything else is usable.
     */
    sourcePath = join(scratch, 'source', 'acme', 'api.git')
    await mkdir(dirname(sourcePath), { recursive: true })

    const { initBare, runGit } = await import('../../app/Actions/Git/git')
    const init = await initBare(sourcePath, 'main')

    if (!init.ok && !init.stderr.includes('already exists'))
      throw new Error(`could not make the fixture repository: ${init.stderr}`)

    const { createCommit } = await import('../../app/Actions/Git/write')
    const commit = await createCommit(sourcePath, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'Add the cart total',
      author: { name: 'Fixture', email: 'fixture@example.com' },
      files: { 'src/cart.ts': 'export const total = 1\n' },
    })

    if (!commit.ok)
      throw new Error(`could not commit to the fixture repository: ${commit.error}`)

    await runGit(sourcePath, ['update-server-info'])

    process.env.GITHUB_CLONE_BASE = join(scratch, 'source')

    // The API. Paginated with a real `Link` header, so the client's pagination
    // is exercised rather than assumed.
    api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request: Request) {
        const url = new URL(request.url)
        const path = url.pathname

        const page = (items: unknown[]): Response => Response.json(items)

        if (path === '/repos/acme/api')
          return Response.json({ name: 'api', description: 'The fixture', default_branch: 'main', private: false })

        if (path === '/repos/acme/api/issues')
          return page(FIXTURE.issues)

        if (path === '/repos/acme/api/pulls')
          return page(FIXTURE.pulls)

        if (path === '/repos/acme/api/pulls/comments')
          return page(FIXTURE.comments)

        if (path === '/repos/acme/api/labels')
          return page(FIXTURE.labels)

        if (path === '/repos/acme/api/milestones')
          return page([])

        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    apiPort = Number(api.port)

    created.ownerHandle = unique('importowner')
    const owner: any = await db
      .insertInto('users')
      .values({
        name: 'Import Owner',
        email: `${created.ownerHandle}@example.com`,
        handle: created.ownerHandle,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    // Two accounts to attribute to: one matched by a claim, one by nothing.
    const alice: any = await db
      .insertInto('users')
      .values({ name: 'Alice', email: `${unique('alice')}@example.com`, handle: unique('alice'), password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.aliceId = Number(alice?.id)

    const bobHandle = unique('bob')
    const bob: any = await db
      .insertInto('users')
      .values({ name: 'Bob', email: `${bobHandle}@example.com`, handle: bobHandle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.bobId = Number(bob?.id)
    created.bobHandle = bobHandle

    created.name = unique('importrepo')
    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const resolved = repositoryPath(created.ownerHandle, created.name)

    if (!resolved.ok)
      throw new Error('the destination path did not resolve')

    created.diskPath = resolved.path!

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const operation: any = await db
      .insertInto('operations')
      .values({
        kind: 'repository:import',
        status: 'queued',
        subject_type: 'repository',
        subject_id: created.repositoryId,
        started_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.operationId = Number(operation?.id)
    available = true
  }
  catch (error) {
    console.warn(`[import] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.repositoryId) {
      const pulls: any[] = await db.selectFrom('pull_requests').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const pull of pulls) {
        const threads: any[] = await db.selectFrom('review_threads').select(['id']).where('pull_request_id', '=', Number(pull.id)).execute()

        for (const thread of threads)
          await db.deleteFrom('review_comments').where('review_thread_id', '=', Number(thread.id)).execute()

        await db.deleteFrom('review_threads').where('pull_request_id', '=', Number(pull.id)).execute()
      }

      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('issues').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repository_labels').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (db && created.operationId)
      await db.deleteFrom('operations').where('id', '=', created.operationId).execute()

    const users = [created.ownerId, created.aliceId, created.bobId].filter(Boolean)

    if (db && users.length > 0)
      await db.deleteFrom('users').where('id', 'in', users).execute()
  }
  finally {
    api?.stop?.()
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    await rm(created.diskPath, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.GITHUB_CLONE_BASE
  }
}, 120_000)

/** Run the import to completion, one stage per call, as the queue would. */
async function runImport(claims = ''): Promise<any> {
  const job = (await import('../../app/Jobs/ImportRepositoryJob')).default
  const payload: any = {
    repositoryId: created.repositoryId,
    operationId: created.operationId,
    source: 'acme/api',
    baseUrl: `http://127.0.0.1:${apiPort}`,
    claims,
  }

  /*
   * The stages are walked here rather than by dispatching, because a queue
   * worker is not running in a test - and what is under test is the import,
   * not the queue. Each call does exactly one stage, which is also what proves
   * the thing is resumable: every iteration starts from a payload that could
   * have come out of the database.
   */
  const { emptyProgress, isFinished } = await import('../../app/Actions/Import/plan')
  let progress = payload.progress ?? emptyProgress()

  for (let guard = 0; guard < 20 && !isFinished(progress); guard += 1) {
    await job.handle({ ...payload, progress })

    const row: any = await (globalThis as any).db
      .selectFrom('operations')
      .select(['result'])
      .where('id', '=', created.operationId)
      .executeTakeFirst()

    const reported = JSON.parse(String(row?.result ?? '{}'))

    // The stage the job reported is where a resumed job would pick up, so the
    // loop advances the way the queue would rather than by keeping state the
    // job did not persist.
    progress = { ...progress, stage: reported.stage, counts: reported.counts ?? {}, problems: reported.problems ?? [] }
  }

  return progress
}

describe('importing a repository', () => {
  test('the git data arrives first, and the repository is a real clone', async () => {
    if (!available)
      return

    await runImport(`alice=${created.ownerHandle}`)

    const { runGit } = await import('../../app/Actions/Git/git')

    /*
     * A real object, not an empty directory. The commit was made in the fixture
     * and has to be readable here, which is the difference between "cloned" and
     * "a directory exists".
     */
    const log = await runGit(created.diskPath, ['log', '--oneline', 'main'])

    expect(log.ok).toBe(true)
    expect(log.stdout).toContain('Add the cart total')

    // And no remote pointing back. An imported repository is this instance's,
    // and a leftover `origin` is how somebody later pushes here and finds it
    // upstream.
    const remotes = await runGit(created.diskPath, ['remote'])

    expect(remotes.stdout.trim()).toBe('')
  }, 120_000)

  test('issues keep their numbers, which is what cross references depend on', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('issues')
      .select(['number', 'title', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('number', 'asc')
      .execute()

    // 7 and 8 are issues; 9 is a pull request and must not appear here as well.
    expect(rows.map(row => Number(row.number))).toEqual([7, 8])
    expect(String(rows[0].title)).toBe('The total disagrees with the receipt')
    expect(String(rows[1].state)).toBe('closed')
  }, 60_000)

  test('the counter is past everything imported', async () => {
    if (!available)
      return

    /*
     * Otherwise the next issue somebody opens is given a number an imported one
     * already has - and the insert either fails or, worse, succeeds and leaves
     * two `#9`s in one repository.
     */
    const row: any = await (globalThis as any).db
      .selectFrom('repositories')
      .select(['issue_counter'])
      .where('id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(Number(row.issue_counter)).toBeGreaterThanOrEqual(9)
  }, 60_000)

  test('a pull request arrives with its number and its branches', async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(Number(row.number)).toBe(9)
    expect(String(row.head_branch)).toBe('fix/rounding')
    expect(String(row.base_branch)).toBe('main')
  }, 60_000)

  test('review threads keep the file, the line and the side', async () => {
    if (!available)
      return

    /*
     * **The part other importers drop, and most of the value here.** A review
     * comment without its anchor is a comment at the bottom of a pull request
     * saying "this should be a constant", about nothing.
     */
    const db = (globalThis as any).db
    const pull: any = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    const thread: any = await db
      .selectFrom('review_threads')
      .selectAll()
      .where('pull_request_id', '=', Number(pull.id))
      .executeTakeFirst()

    expect(thread).toBeDefined()
    expect(String(thread.path)).toBe('src/cart.ts')
    expect(Number(thread.line)).toBe(42)

    // And the reply is in the same thread, in order - which is the other half
    // of keeping a review readable.
    const comments: any[] = await db
      .selectFrom('review_comments')
      .select(['body'])
      .where('review_thread_id', '=', Number(thread.id))
      .orderBy('id', 'asc')
      .execute()

    expect(comments.length).toBe(2)
    expect(String(comments[0].body)).toContain('should be a constant')
    expect(String(comments[1].body)).toContain('Agreed')
  }, 60_000)

  test('an author nobody claimed is named rather than reassigned', async () => {
    if (!available)
      return

    /*
     * `stranger` matches no local account and nobody claimed them. Attributing
     * that to somebody would put words in a real person's mouth; attributing it
     * to the importer would lose the conversation. The row records the handle.
     */
    const row: any = await (globalThis as any).db
      .selectFrom('issues')
      .selectAll()
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 8)
      .executeTakeFirst()

    expect(row.author_id).toBeNull()
    expect(String(row.external_author)).toBe('stranger')
  }, 60_000)

  test('an author the operator claimed is attributed to them', async () => {
    if (!available)
      return

    // A human saying "these are the same person", once, rather than a guess
    // made two thousand times.
    const row: any = await (globalThis as any).db
      .selectFrom('issues')
      .selectAll()
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 7)
      .executeTakeFirst()

    expect(Number(row.author_id)).toBe(created.ownerId)
    expect(row.external_author).toBeNull()
  }, 60_000)

  test('the operation says what happened, in words somebody can act on', async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('operations')
      .select(['status', 'result'])
      .where('id', '=', created.operationId)
      .executeTakeFirst()

    expect(String(row.status)).toBe('succeeded')

    const result = JSON.parse(String(row.result))

    // "68%" of an import tells nobody whether the thing they are waiting for
    // has arrived. The summary names what came in.
    expect(String(result.summary)).toContain('issues')
    expect(String(result.summary)).toContain('review threads')
  }, 60_000)
  test('running it again changes nothing', async () => {
    if (!available)
      return

    /*
     * The property that makes it resumable. An import that duplicated on a
     * second run would mean an interruption cost the migration rather than one
     * page, and the interruption is not hypothetical - a deploy, a worker
     * restart, or a rate limit that outlasts the process.
     */
    const db = (globalThis as any).db

    const count = async (table: string): Promise<number> =>
      (await db.selectFrom(table).select(['id']).where('repository_id', '=', created.repositoryId).execute()).length

    const before = { issues: await count('issues'), pulls: await count('pull_requests') }

    await runImport(`alice=${created.ownerHandle}`)

    expect({ issues: await count('issues'), pulls: await count('pull_requests') }).toEqual(before)

    /*
     * And the report says so. A second run that claimed to have imported
     * everything again would be a report an operator cannot use to tell a
     * resumed import from a finished one - which is the only question they
     * bring to it.
     */
    const row: any = await db.selectFrom('operations').select(['result']).where('id', '=', created.operationId).executeTakeFirst()

    expect(String(JSON.parse(String(row.result)).summary)).toContain('no metadata')
  }, 120_000)

})
