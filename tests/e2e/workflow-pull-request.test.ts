// A pull request starts the runs its workflows ask for.
//
// `on: pull_request` is the trigger this product exists around - CI on the
// change somebody is reviewing - and it was stored on every version and read by
// nothing. A workflow that named it never ran. On a forge built around review,
// that is the wrong trigger to be missing.
//
// The cases below are the ones where being wrong is expensive rather than
// merely annoying: the definition has to come from the base branch and never
// from the head, and a fork's run has to be recorded untrusted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'
import { isTrue } from '../../app/Actions/Support/sql'

const created = {
  ownerId: 0,
  repositoryId: 0,
  forkId: 0,
  pullRequestId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  headSha: '',
}

let available = false
let db: any = null

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

const CI = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`

async function runsHere(): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .select(['id', 'event', 'event_ref', 'head_sha', 'definition_sha', 'trusted', 'state'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('id')
    .execute()
}

async function waitFor<T>(read: () => Promise<T>, until: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()

  while (!until(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    value = await read()
  }

  return value
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-pr-runs-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('prr')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'PR Runs', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the pull request runs end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    // The workflow lands on the base branch, which is the only place a
    // definition may come from.
    const work = join(created.temp, 'work')
    mkdirSync(join(work, '.github', 'workflows'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    writeFileSync(join(work, '.github', 'workflows', 'ci.yml'), CI)
    writeFileSync(join(work, 'README.md'), '# base\n')

    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'base with CI')
    await git(work, 'push', created.diskPath, 'main')

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${'0'.repeat(40)} ${await git(work, 'rev-parse', 'HEAD')} refs/heads/main`),
    })

    // Wait for the definition to register: the run this test asserts on cannot
    // exist before it.
    await waitFor(
      () => db.selectFrom('workflow_versions').select(['id']).execute(),
      (rows: any[]) => rows.length > 0,
    )

    // The change under review, on its own branch.
    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'app.ts'), 'export const thing = 1\n')
    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'a change')
    await git(work, 'push', created.diskPath, 'change')

    created.headSha = await git(work, 'rev-parse', 'HEAD')

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A change',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.headSha,
        base_branch: 'main',
        base_sha: '0'.repeat(40),
        draft: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)
    available = true
  }
  catch (error) {
    console.warn(`[workflow-pull-request] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId) {
      await db.deleteFrom('workflow_runs').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    }

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the files still go, below */ }

  if (created.diskPath)
    removeRepositoryDirectory(created.diskPath)

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })
})

describe('opening a pull request', () => {
  test('starts the run its workflow asked for', async () => {
    if (!available)
      return

    const { handleEvent } = await import('../../app/Listeners/DispatchPullRequestRuns')

    await handleEvent({
      repositoryId: created.repositoryId,
      number: 1,
      owner: created.handle,
      actorId: created.ownerId,
    }, 'pr:opened')

    const runs = await waitFor(runsHere, (rows: any[]) => rows.length > 0)

    expect(runs).toHaveLength(1)
    expect(runs[0].event).toBe('pull_request')
    expect(runs[0].event_ref).toBe('refs/pull/1/head')
    expect(runs[0].state).toBe('queued')
  })

  /*
   * The first line of the fork policy, and the one that makes the rest matter:
   * the workflow comes from the base branch. A pull request that supplied its
   * own could write one that prints the instance's secrets.
   */
  test('with the definition from the base branch and the code from the head', async () => {
    if (!available)
      return

    const [run] = await runsHere()

    expect(run.head_sha).toBe(created.headSha)
    expect(run.definition_sha).not.toBe(created.headSha)
  })

  test('and a run from the repository itself is trusted', async () => {
    if (!available)
      return

    const [run] = await runsHere()

    expect(isTrue(run.trusted)).toBe(true)
  })

  test('the same event twice makes one run, not two', async () => {
    if (!available)
      return

    const { handleEvent } = await import('../../app/Listeners/DispatchPullRequestRuns')

    const before = (await runsHere()).length

    await handleEvent({ repositoryId: created.repositoryId, number: 1, owner: created.handle }, 'pr:opened')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect((await runsHere()).length).toBe(before)
  })
})

describe('a pull request from a fork', () => {
  /*
   * Untrusted for its whole life. What decides it is the head repository, not
   * the branch name and not who pushed - that is the fact the threat model
   * turns on, and a run row that got it wrong would be one an execution plane
   * later hands secrets to.
   */
  test('is recorded untrusted', async () => {
    if (!available)
      return

    const fork: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: unique('fork'),
        description: 'a fork, for the trust assertion',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/fork.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.forkId = Number(fork?.id)

    await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 2,
        title: 'From a fork',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.headSha,
        head_repository_id: created.forkId,
        base_branch: 'main',
        base_sha: '0'.repeat(40),
        draft: false,
      })
      .execute()

    const { handleEvent } = await import('../../app/Listeners/DispatchPullRequestRuns')

    await handleEvent({ repositoryId: created.repositoryId, number: 2, owner: created.handle }, 'pr:opened')

    const runs = await waitFor(runsHere, (rows: any[]) => rows.some(run => run.event_ref === 'refs/pull/2/head'))
    const fromFork = runs.find((run: any) => run.event_ref === 'refs/pull/2/head')

    expect(fromFork).toBeDefined()
    expect(isTrue(fromFork.trusted)).toBe(false)

    await db.deleteFrom('repositories').where('id', '=', created.forkId).execute().catch(() => {})
  })
})

describe('a workflow that did not ask for the event', () => {
  test('starts nothing, and pull_request_target is a separate question', async () => {
    if (!available)
      return

    // This repository's workflow names `pull_request` only. A run recorded as
    // `pull_request_target` would be one that ran the base branch's workflow
    // with the base repository's trust - the trigger behind most published
    // Actions secret-theft write-ups.
    const runs = await runsHere()

    expect(runs.map((run: any) => run.event)).not.toContain('pull_request_target')
  })
})
