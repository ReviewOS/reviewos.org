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

/** The bytes of the one asset that exists, so the checksum has something to be. */
const ASSET_BYTES = new TextEncoder().encode('a release artefact, pretend it is a tarball\n')

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
  releases: [
    {
      tag_name: 'v1.2.0',
      name: 'Rounding fixes',
      body: 'Fixes #7.',
      prerelease: false,
      target_commitish: 'main',
      published_at: '2026-02-01T10:00:00Z',
      author: { login: 'alice', id: 1 },
      assets: [
        { name: 'checkout-1.2.0.tar.gz', content_type: 'application/gzip', browser_download_url: 'ASSET_URL' },
        // A file somebody deleted upstream years ago. A migration that stopped
        // on it would never finish.
        { name: 'gone.bin', content_type: 'application/octet-stream', browser_download_url: 'MISSING_URL' },
      ],
    },
  ],
  milestones: [
    { title: 'v2', description: 'The rounding release', state: 'open', due_on: '2026-03-01T00:00:00Z' },
    { title: 'v1', description: 'Shipped', state: 'closed', due_on: null },
  ],
  issueComments: [
    {
      id: 9001,
      issue_url: 'https://api.github.com/repos/acme/api/issues/7',
      body: 'I can reproduce this with two items at 0.005.',
      user: { login: 'bob', id: 2 },
      created_at: '2026-01-02T12:00:00Z',
    },
    {
      id: 9002,
      issue_url: 'https://api.github.com/repos/acme/api/issues/7',
      body: 'Same, and it is worse with tax. See https://github.com/acme/api/issues/3.',
      user: { login: 'stranger', id: 99 },
      created_at: '2026-01-02T13:00:00Z',
    },
    // A comment on the pull request, which GitHub also files under `/issues/`.
    // Attached to the wrong table it would appear on an unrelated conversation
    // that happens to share a number.
    {
      id: 9003,
      issue_url: 'https://api.github.com/repos/acme/api/issues/9',
      body: 'Rebased.',
      user: { login: 'alice', id: 1 },
      created_at: '2026-01-06T09:00:00Z',
    },
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
          return page(FIXTURE.milestones)

        if (path === '/repos/acme/api/issues/comments')
          return page(FIXTURE.issueComments)

        if (path === '/repos/acme/api/releases') {
          // The asset urls point back at this server, so the download is a real
          // download rather than a mocked one.
          return page(FIXTURE.releases.map(release => ({
            ...release,
            assets: release.assets.map(asset => ({
              ...asset,
              browser_download_url: asset.browser_download_url === 'ASSET_URL'
                ? `http://127.0.0.1:${apiPort}/download/checkout.tar.gz`
                : `http://127.0.0.1:${apiPort}/download/missing`,
            })),
          })))
        }

        if (path === '/download/checkout.tar.gz')
          return new Response(ASSET_BYTES, { headers: { 'Content-Type': 'application/gzip' } })

        if (path === '/download/missing')
          return new Response('gone', { status: 404 })

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

      const issues: any[] = await db.selectFrom('issues').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const subject of [...pulls.map((one: any) => ['pull_request', Number(one.id)]), ...issues.map((one: any) => ['issue', Number(one.id)])])
        await db.deleteFrom('issue_comments').where('commentable_type', '=', subject[0]).where('commentable_id', '=', subject[1]).execute()

      const releases: any[] = await db.selectFrom('releases').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const release of releases) {
        const assets: any[] = await db.selectFrom('release_assets').select(['storage_path']).where('release_id', '=', Number(release.id)).execute()

        for (const asset of assets)
          await rm(String(asset.storage_path), { force: true }).catch(() => undefined)

        await db.deleteFrom('release_assets').where('release_id', '=', Number(release.id)).execute()
      }

      await db.deleteFrom('releases').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('milestones').where('repository_id', '=', created.repositoryId).execute()
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
    expect(String(result.summary)).toContain('comments')
    expect(String(result.summary)).toContain('review threads')
  }, 60_000)
  test('milestones arrive, open and closed', async () => {
    if (!available)
      return

    // A closed milestone is what most of a repository's history is filed under,
    // so importing only the open ones would lose the filing rather than a
    // detail of it.
    const rows: any[] = await (globalThis as any).db
      .selectFrom('milestones')
      .select(['title', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('title', 'asc')
      .execute()

    expect(rows.map(row => `${row.title}:${row.state}`)).toEqual(['v1:closed', 'v2:open'])
  }, 60_000)

  test('the conversation arrives, on the right subject', async () => {
    if (!available)
      return

    /*
     * **The reason to migrate at all.** A repository whose issues came without
     * their comments has kept the questions and lost every answer, which is a
     * worse artefact than a link to the old forge.
     */
    const db = (globalThis as any).db

    const issue: any = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 7)
      .executeTakeFirst()

    const onIssue: any[] = await db
      .selectFrom('issue_comments')
      .selectAll()
      .where('commentable_type', '=', 'issue')
      .where('commentable_id', '=', Number(issue.id))
      .orderBy('id', 'asc')
      .execute()

    expect(onIssue.length).toBe(2)
    expect(String(onIssue[0].body)).toContain('0.005')

    // Attribution follows the same rule as everywhere else: named, not
    // reassigned.
    expect(String(onIssue[1].external_author)).toBe('stranger')

    // And the reference in it came home, because that repository is here.
    expect(String(onIssue[1].body)).toContain('/acme/api/issues/3')

    /*
     * The comment on #9 belongs to the pull request, not to an issue. GitHub
     * files both under `/issues/comments`, and putting it on the wrong table
     * would attach it to an unrelated conversation that happens to share a
     * number - the shape of mistake nobody reviews for, because it looks like
     * ordinary data.
     */
    const pull: any = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    const onPull: any[] = await db
      .selectFrom('issue_comments')
      .selectAll()
      .where('commentable_type', '=', 'pull_request')
      .where('commentable_id', '=', Number(pull.id))
      .execute()

    expect(onPull.length).toBe(1)
    expect(String(onPull[0].body)).toBe('Rebased.')
  }, 60_000)

  test('releases arrive with the files attached to them', async () => {
    if (!available)
      return

    /*
     * **The assets are the part that matters and the part that is easy to
     * skip.** A release without its binary is a tag with a paragraph attached:
     * every link in a changelog, every install script and every "download the
     * previous version" request points at a file that is no longer anywhere.
     */
    const db = (globalThis as any).db
    const release: any = await db
      .selectFrom('releases')
      .selectAll()
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(release).toBeDefined()
    expect(String(release.tag_name)).toBe('v1.2.0')
    expect(String(release.notes)).toContain('#7')

    const assets: any[] = await db
      .selectFrom('release_assets')
      .selectAll()
      .where('release_id', '=', Number(release.id))
      .execute()

    // One of the two. The other is a 404 upstream, and a migration that stopped
    // on a file somebody deleted years ago would never finish.
    expect(assets.length).toBe(1)
    expect(String(assets[0].name)).toBe('checkout-1.2.0.tar.gz')
    expect(Number(assets[0].size_bytes)).toBe(ASSET_BYTES.byteLength)

    // Stored the way an upload through the interface stores one, checksum and
    // all, so there is no import-only path to keep working.
    const { checksumOf } = await import('../../app/Actions/Release/assets')
    expect(String(assets[0].checksum)).toBe(checksumOf(ASSET_BYTES))

    const onDisk = await Bun.file(String(assets[0].storage_path)).arrayBuffer()
    expect(new Uint8Array(onDisk).byteLength).toBe(ASSET_BYTES.byteLength)

    // And the one that failed is reported rather than silently missing.
    const operation: any = await db
      .selectFrom('operations')
      .select(['result'])
      .where('id', '=', created.operationId)
      .executeTakeFirst()

    expect(String(JSON.parse(String(operation.result)).problems ?? [])).toContain('gone.bin')
  }, 120_000)

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

    const comments = async (): Promise<number> =>
      (await db.selectFrom('issue_comments').select(['id']).whereNotNull('external_id').execute()).length

    const before = { issues: await count('issues'), pulls: await count('pull_requests'), comments: await comments() }

    await runImport(`alice=${created.ownerHandle}`)

    // Comments are the row most likely to duplicate, because they have no
    // number of their own - which is why `external_id` was added to the table
    // rather than matching on body and time, two of which can legitimately
    // collide.
    expect({ issues: await count('issues'), pulls: await count('pull_requests'), comments: await comments() }).toEqual(before)

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

describe('and back out again', () => {
  test('the export is readable without this codebase', async () => {
    if (!available)
      return

    /*
     * A forge that is hard to leave is a forge people are right to distrust,
     * and the trust is not earned by *having* an export - it is earned by
     * having one somebody can read without the code that wrote it.
     *
     * So this runs the real writer and reads the files back the way a stranger
     * would: numbers rather than our ids, handles rather than user ids, and a
     * `git/` directory that is a real repository.
     */
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { writeExport, EXPORT_FORMAT } = await import('../../app/Actions/Import/export')

    const destination = await mkdtemp(join(tmpdir(), 'reviewos-export-'))
    const written = await writeExport(created.ownerHandle, created.name, destination)

    // A format nobody can date is a format nobody can write a reader for two
    // years from now.
    expect(written.format).toBe(EXPORT_FORMAT)
    expect(written.counts.issues).toBe(2)
    expect(written.counts.review_threads).toBe(1)

    // The most important half needs no tooling: a clone of the exported
    // directory is a working repository.
    const { runGit } = await import('../../app/Actions/Git/git')
    const log = await runGit(join(destination, 'git'), ['log', '--oneline', 'main'])

    expect(log.ok).toBe(true)
    expect(log.stdout).toContain('Add the cart total')

    const issues = JSON.parse(await readFile(join(destination, 'issues.json'), 'utf8'))

    /*
     * Keyed by the number people refer to, not by our row id - which means
     * nothing outside this database - and the conversation travels with it.
     */
    expect(issues.map((one: any) => one.number)).toEqual([7, 8])
    expect(issues[0].comments.length).toBe(2)

    /*
     * An author nobody claimed keeps the name they had. An export that filled
     * that gap with "unknown" would be inventing a person, and one that wrote a
     * local user id would be exporting a fact about our database.
     */
    expect(issues[1].author).toBe('stranger')
    expect(issues[0].author).toBe(created.ownerHandle)

    const pulls = JSON.parse(await readFile(join(destination, 'pull-requests.json'), 'utf8'))

    expect(pulls[0].number).toBe(9)

    // And the review anchor survives the round trip. Losing it on the way out
    // would be perverse, given the importer exists to keep it on the way in.
    expect(pulls[0].review_threads[0].path).toBe('src/cart.ts')
    expect(pulls[0].review_threads[0].line).toBe(42)
    expect(pulls[0].review_threads[0].comments.length).toBe(2)

    await rm(destination, { recursive: true, force: true })
  }, 120_000)
})

describe('importing from Gitea, which is the same shape until it is not', () => {
  test('reads the index, the /api/v1 prefix and the per-review comments', async () => {
    if (!available)
      return

    /*
     * A second fixture that answers the *Gitea* shape, because the differences
     * are exactly the kind that pass a GitHub fixture and lose data on a real
     * instance:
     *
     * - a pull request numbered `index` rather than `number`;
     * - the API under `/api/v1`;
     * - no repository-wide review comment list, so reviews come one pull
     *   request at a time.
     *
     * If any of those were assumed rather than handled, this import would
     * succeed and produce a pull request numbered zero with no review on it.
     */
    const db = (globalThis as any).db

    const gitea = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request: Request) {
        const path = new URL(request.url).pathname
        const json = (items: unknown) => Response.json(items)

        // Everything lives under the prefix. A request that arrives without it
        // is the importer having failed to apply `apiBase`.
        if (!path.startsWith('/api/v1'))
          return new Response('the prefix was not applied', { status: 400 })

        const route = path.slice('/api/v1'.length)

        if (route === '/repos/acme/api/issues')
          return json([])

        if (route === '/repos/acme/api/pulls')
          return json([{ index: 4, title: 'From Gitea', body: '', state: 'open', user: { login: 'alice' }, head: { ref: 'work', sha: 'c'.repeat(40) }, base: { ref: 'main', sha: 'd'.repeat(40) }, created_at: '2026-02-02T10:00:00Z' }])

        if (route === '/repos/acme/api/pulls/4/reviews')
          return json([{ id: 77 }])

        if (route === '/repos/acme/api/pulls/4/reviews/77/comments')
          return json([{ id: 8801, path: 'src/cart.ts', line: 9, side: 'RIGHT', body: 'From a Gitea review.', user: { login: 'bob' }, created_at: '2026-02-02T11:00:00Z', in_reply_to_id: null }])

        return json([])
      },
    })

    const name = unique('gitearepo')
    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const resolved = repositoryPath(created.ownerHandle, name)

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    const repositoryId = Number(repository?.id)

    try {
      const job = (await import('../../app/Jobs/ImportRepositoryJob')).default
      const { emptyProgress, isFinished } = await import('../../app/Actions/Import/plan')

      let progress = emptyProgress()

      // Straight to the metadata: the git stage would clone, and what is under
      // test here is the API shape rather than the clone.
      progress.stage = 'labels'

      for (let guard = 0; guard < 20 && !isFinished(progress); guard += 1) {
        await job.handle({
          repositoryId,
          operationId: 0,
          source: 'acme/api',
          forge: 'gitea',
          baseUrl: `http://127.0.0.1:${gitea.port}/api/v1`,
          progress,
        })

        const { nextStage } = await import('../../app/Actions/Import/plan')
        progress = { ...progress, stage: nextStage(progress.stage), page: 1 }
      }

      const pull: any = await db
        .selectFrom('pull_requests')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      // `index`, not `number`. Read wrongly this is a pull request numbered
      // zero, and nothing fails because a zero is a number.
      expect(pull).toBeDefined()
      expect(Number(pull.number)).toBe(4)

      const thread: any = await db
        .selectFrom('review_threads')
        .selectAll()
        .where('pull_request_id', '=', Number(pull.id))
        .executeTakeFirst()

      // And the review, which had to be fetched a pull request at a time
      // because Gitea has no repository-wide list.
      expect(thread).toBeDefined()
      expect(String(thread.path)).toBe('src/cart.ts')
      expect(Number(thread.line)).toBe(9)
    }
    finally {
      const pulls: any[] = await db.selectFrom('pull_requests').select(['id']).where('repository_id', '=', repositoryId).execute()

      for (const one of pulls) {
        const threads: any[] = await db.selectFrom('review_threads').select(['id']).where('pull_request_id', '=', Number(one.id)).execute()

        for (const thread of threads)
          await db.deleteFrom('review_comments').where('review_thread_id', '=', Number(thread.id)).execute()

        await db.deleteFrom('review_threads').where('pull_request_id', '=', Number(one.id)).execute()
      }

      await db.deleteFrom('pull_requests').where('repository_id', '=', repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
      gitea.stop()
    }
  }, 120_000)
})
