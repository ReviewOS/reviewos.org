// Test results on the pull request, and the sentence nobody else writes.
//
// "There are seven flaky tests" is a sentence a reviewer learns to skip - it is
// true of every pull request in the repository, because flakiness elsewhere is
// stored as a property of the test. The sentence worth rendering is "six of
// these were already flaky on main, and this branch made the seventh flaky",
// and getting it right means measuring the same rule twice: once over this
// branch's history and once over the base's.
//
// So the fixture below is mostly history. The page assertions are short; what
// takes the setup is arranging a test that is unreliable on both branches and
// one that is unreliable only on this one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = {
  ownerId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  headSha: '',
  baseSha: '',
}

let available = false
let db: any = null
let port = 0
let server: any = null
let ingestTestRun: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
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

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

async function testsPage(query = ''): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/tests${query}`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

async function checksTab(): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1?tab=checks`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

/** Markup with its tags removed, since a sentence is split across elements. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

/** One reported run, on a named branch and commit. */
async function report(over: Record<string, any>): Promise<any> {
  return ingestTestRun({
    repositoryId: created.repositoryId,
    suite: 'unit',
    source: 'json',
    ...over,
  })
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-pull-tests-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    ingestTestRun = (await import('../../app/Actions/Tests/ingest')).ingestTestRun

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('ptst')

    const user: any = await db.insertInto('users')
      .values({ name: 'Test Reader', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(user?.id)
    created.name = unique('repo')

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: resolved.relative!,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\nexport const second = 2\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the change')
    created.headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    await db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'Tests fixture',
      body: '',
      author_id: created.ownerId,
      state: 'open',
      head_branch: 'change',
      head_sha: created.headSha,
      base_branch: 'main',
      base_sha: created.baseSha,
      draft: false,
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }).execute()

    /*
     * The base's history: `already-flaky` disagrees with itself on the base
     * commit, and `steady` never has. That disagreement is what makes the
     * distinction on the page a measurement rather than a label.
     */
    await report({
      headSha: created.baseSha,
      branch: 'main',
      key: 'base-1',
      executions: [
        { scope: 'unit/a.test.ts', name: 'already-flaky', result: 'passed' },
        { scope: 'unit/b.test.ts', name: 'newly-flaky', result: 'passed' },
        { scope: 'unit/c.test.ts', name: 'steady', result: 'passed' },
      ],
    })

    await report({
      headSha: created.baseSha,
      branch: 'main',
      key: 'base-2',
      executions: [
        { scope: 'unit/a.test.ts', name: 'already-flaky', result: 'failed', failureMessage: 'flaked on main too' },
        { scope: 'unit/b.test.ts', name: 'newly-flaky', result: 'passed' },
        { scope: 'unit/c.test.ts', name: 'steady', result: 'passed' },
      ],
    })

    /*
     * This branch: both tests disagree with themselves here, and one of them
     * is broken outright. Only `newly-flaky` is this branch's doing.
     */
    await report({
      headSha: created.headSha,
      branch: 'change',
      key: 'head-1',
      executions: [
        { scope: 'unit/a.test.ts', name: 'already-flaky', result: 'passed' },
        { scope: 'unit/b.test.ts', name: 'newly-flaky', result: 'passed' },
        { scope: 'unit/c.test.ts', name: 'steady', result: 'passed' },
        { scope: 'unit/d.test.ts', name: 'plainly broken', result: 'failed', failureMessage: 'expected 2 to be 3' },
      ],
    })

    await report({
      headSha: created.headSha,
      branch: 'change',
      key: 'head-2',
      executions: [
        { scope: 'unit/a.test.ts', name: 'already-flaky', result: 'failed', failureMessage: 'flaked here as well' },
        { scope: 'unit/b.test.ts', name: 'newly-flaky', result: 'failed', failureMessage: 'this branch broke it' },
        { scope: 'unit/c.test.ts', name: 'steady', result: 'passed' },
        { scope: 'unit/d.test.ts', name: 'plainly broken', result: 'failed', failureMessage: 'expected 2 to be 3' },
      ],
    })

    available = true
  }
  catch (error) {
    console.warn(`[pull-tests] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  rmSync(created.temp, { recursive: true, force: true })
  removeRepositoryDirectory(created.diskPath)
})

describe('the tests panel on a pull request', () => {
  test('says which tests failed, not only that something did', async () => {
    if (!available)
      return

    const rendered = text(await checksTab())

    // A check says "the job failed". This says which test, and what it said -
    // the two things somebody opens the log for.
    expect(rendered).toContain('plainly broken')
    expect(rendered).toContain('expected 2 to be 3')
    expect(rendered).toContain('unit/d.test.ts')
  }, 180_000)

  test('and separates what this branch made flaky from what was flaky already', async () => {
    if (!available)
      return

    const rendered = text(await checksTab())

    /*
     * The whole feature in two sentences. `already-flaky` disagreed with
     * itself on main before this branch existed, so it is not this reviewer's
     * problem; `newly-flaky` only started disagreeing here.
     */
    expect(rendered).toContain('This branch made 1 test flaky')
    expect(rendered).toContain('newly-flaky')
    expect(rendered).toContain('already flaky on main')
  }, 180_000)

  test('a test that never wavered is not mentioned at all', async () => {
    if (!available)
      return

    // A panel that lists every test is a panel nobody reads. Only the failures
    // and the unreliable ones earn space.
    const rendered = text(await checksTab())

    expect(rendered).not.toContain('steady')
  }, 180_000)

  test('and a commit nothing has reported on says so rather than showing green', async () => {
    if (!available)
      return

    /*
     * The state a misconfigured collector leaves every commit in. Rendering it
     * the same as a passing suite is how nobody notices for a month, which is
     * the same rule the checks rollup above it follows.
     */
    await db.updateTable('pull_requests')
      .set({ head_sha: created.baseSha.replace(/^.{4}/, 'dead') })
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 1)
      .execute()

    const rendered = text(await checksTab())

    expect(rendered).toContain('Nothing has reported test results for this commit')

    await db.updateTable('pull_requests')
      .set({ head_sha: created.headSha })
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 1)
      .execute()
  }, 180_000)
})

/*
 * The repository's own tests page.
 *
 * Every number on it is derivable from the execution table by anybody willing
 * to write SQL, which means in practice nobody looks: the slow test that got
 * slower over four months is invisible until somebody wonders why CI takes
 * eleven minutes. The page is the whole feature, so these assertions are about
 * what it says rather than what it computes.
 */
describe('the repository tests page', () => {
  test('shows the suites, where the time goes, and what fails', async () => {
    if (!available)
      return

    const rendered = text(await testsPage())

    expect(rendered).toContain('Suites')
    expect(rendered).toContain('Where the time goes')
    expect(rendered).toContain('Least reliable')
    expect(rendered).toContain('plainly broken')
  }, 180_000)

  test('and says how much it could not rank rather than ranking it anyway', async () => {
    if (!available)
      return

    /*
     * Four runs is not a reliability measurement, and a page that presents one
     * as though it were teaches people to distrust the rest of it. The fixture
     * has two runs per branch, so every test here is below the threshold.
     */
    const rendered = text(await testsPage())

    expect(rendered).toMatch(/too few runs in this window to rank/)
  }, 180_000)

  test('a repository nobody has reported for gets the instructions, not an empty table', async () => {
    if (!available)
      return

    const other = unique('repo')

    await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: other,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${other}.git`,
    }).execute()

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${other}/tests`, { headers: { Accept: 'text/html' } })
    const rendered = text(await answer.text())

    // The reason this page is empty is almost always that nobody has pointed a
    // collector at it, and "no data" leaves them to go and find the docs.
    expect(rendered).toContain('No test results have been reported')
    expect(rendered).toContain('/api/repos/tests/ingest')

    await db.deleteFrom('repositories').where('name', '=', other).execute()
  }, 180_000)
})
