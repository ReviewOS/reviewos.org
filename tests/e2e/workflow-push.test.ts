// A workflow file registers itself when it is pushed.
//
// The whole path: a real commit into a real bare repository, the job the
// post-receive hook dispatches, the event it emits, the listener on it, git
// plumbing reading the tree, the parser, and rows. Every piece has its own
// test; this is the one that fails when they are all correct and not connected,
// which is the failure this codebase keeps producing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }

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

/** Commit a file on main, push it, and run the job the hook dispatches. */
async function push(path: string, contents: string): Promise<void> {
  const work = join(created.temp, 'work')
  mkdirSync(join(work, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(work, path), contents)
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', `add ${path}`)

  const before = await git(work, 'rev-parse', 'HEAD~1').catch(() => '0'.repeat(40))
  await git(work, 'push', created.diskPath, 'main')
  const after = await git(work, 'rev-parse', 'HEAD')

  const { parseRefUpdates } = await import('../../app/Actions/Git/push')
  const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

  const result: any = await ProcessPushJob.handle({
    gitDir: created.diskPath,
    updates: parseRefUpdates(`${before} ${after} refs/heads/main`),
  })

  if (result?.ok === false)
    throw new Error(`the push job did nothing: ${result.reason}`)
}

async function workflowsHere(): Promise<any[]> {
  return db
    .selectFrom('workflows')
    .select(['id', 'name', 'path', 'state'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('path')
    .execute()
}

/**
 * Wait for the listener to catch up.
 *
 * `dispatch` is fire-and-forget - the emitter does not await its handlers, and
 * it must not: a push is answered when the refs move, not when everything
 * downstream has finished thinking about it. So the test polls, which is the
 * honest way to assert on a consequence that is deliberately asynchronous.
 * Asserting immediately passes or fails on timing rather than on behaviour.
 */
async function waitFor<T>(read: () => Promise<T>, until: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()

  while (!until(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    value = await read()
  }

  return value
}

const CI = `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-wfpush-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('wfp')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Workflow Push', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the workflow push end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'work')
    mkdirSync(work, { recursive: true })
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'README.md'), 'first\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[workflow-push] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the files still go, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })
    try {
      rmSync(resolve(created.diskPath, '..'), { recursive: false, force: false })
    }
    catch { /* somebody else's repository lives there too */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })
})

describe('pushing a workflow file', () => {
  test('a repository with none has none', async () => {
    if (!available)
      return

    expect(await workflowsHere()).toEqual([])
  })

  test('registers it, with the name from the file', async () => {
    if (!available)
      return

    await push('.github/workflows/ci.yml', CI)

    const workflows = await waitFor(workflowsHere, found => found.length > 0)
    expect(workflows.length).toBe(1)
    expect(workflows[0].name).toBe('CI')
    expect(workflows[0].path).toBe('.github/workflows/ci.yml')
    expect(workflows[0].state).toBe('active')
  })

  test('and a version with the graph the file describes', async () => {
    if (!available)
      return

    const [workflow] = await workflowsHere()

    const version: any = await db
      .selectFrom('workflow_versions')
      .select(['id', 'on_push', 'push_branches', 'source_sha'])
      .where('workflow_id', '=', Number(workflow.id))
      .executeTakeFirst()

    expect(version.on_push).toBe(true)
    expect(version.push_branches).toBe('main')
    expect(String(version.source_sha)).toHaveLength(40)

    const jobs: any[] = await db
      .selectFrom('workflow_version_jobs')
      .select(['job_id'])
      .where('workflow_version_id', '=', Number(version.id))
      .execute()

    expect(jobs.map(job => job.job_id)).toEqual(['test'])
  })

  /*
   * The digest reuse, seen from the outside: a push that does not touch the
   * workflow file must not make a second version of it.
   */
  test('a later push that leaves it alone adds no version', async () => {
    if (!available)
      return

    const [workflow] = await workflowsHere()
    const before: any[] = await db.selectFrom('workflow_versions').select(['id'])
      .where('workflow_id', '=', Number(workflow.id)).execute()

    await push('src/thing.ts', 'export const thing = 1\n')
    await new Promise(resolve => setTimeout(resolve, 1500))

    const after: any[] = await db.selectFrom('workflow_versions').select(['id'])
      .where('workflow_id', '=', Number(workflow.id)).execute()

    expect(after.length).toBe(before.length)
  })

  test('but editing it adds one, against the same workflow', async () => {
    if (!available)
      return

    const [workflow] = await workflowsHere()

    await push('.github/workflows/ci.yml', CI.replace('bun test', 'bun test --coverage'))

    const versions = await waitFor(
      () => db.selectFrom('workflow_versions').select(['id']).where('workflow_id', '=', Number(workflow.id)).execute(),
      (rows: any[]) => rows.length >= 2,
    )

    expect(versions.length).toBe(2)
    expect((await workflowsHere()).length).toBe(1)
  })

  /*
   * One typo must not take the others with it. A repository with two workflows
   * and one mistake should end up with one registered and one reported, not
   * none - the alternative makes a single error look like the feature is off.
   */
  test('a broken file beside a good one does not stop the good one', async () => {
    if (!available)
      return

    await push('.github/workflows/second.yml', 'on: push\njobs:\n  broken: {}\n')

    // Nothing new should appear, so there is no arrival to wait for: settle
    // instead, long enough that a listener which was going to add one has.
    await new Promise(resolve => setTimeout(resolve, 1500))

    const paths = (await workflowsHere()).map(workflow => workflow.path)
    expect(paths).toContain('.github/workflows/ci.yml')
    expect(paths).not.toContain('.github/workflows/second.yml')
  })
})

describe('and the runs it starts', () => {
  async function runsHere(): Promise<any[]> {
    return db
      .selectFrom('workflow_runs')
      .select(['id', 'number', 'state', 'event', 'event_ref', 'head_sha', 'trusted'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id')
      .execute()
  }

  test('a push to the default branch queues a run', async () => {
    if (!available)
      return

    await push('src/again.ts', 'export const again = 2\n')

    const runs = await waitFor(runsHere, found => found.length > 0)

    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].state).toBe('queued')
    expect(runs[0].event).toBe('push')
    expect(runs[0].event_ref).toBe('refs/heads/main')
    // A push to the repository's own branch: the code and the workflow are
    // both from the repository, and whoever pushed has write access.
    expect(runs[0].trusted).toBe(true)
  })

  test('with the jobs the definition describes, waiting rather than running', async () => {
    if (!available)
      return

    const runs = await runsHere()
    const jobs: any[] = await db
      .selectFrom('workflow_jobs')
      .select(['job_id', 'state'])
      .where('workflow_run_id', '=', Number(runs[0].id))
      .execute()

    expect(jobs.map(job => job.job_id)).toEqual(['test'])
    // No `needs`, so it is ready to be handed out - and nothing hands it out,
    // because this instance has no execution plane.
    expect(jobs[0].state).toBe('queued')
  })

  /*
   * The property the unique index exists for. A webhook redelivery, a retried
   * job, or two schedulers reading at once must not turn one push into two
   * runs - and a duplicated run is not a cosmetic problem, it is two builds
   * competing to report a status for the same commit.
   */
  test('the same push delivered twice makes one run, not two', async () => {
    if (!available)
      return

    const { syncFromPush } = await import('../../app/Listeners/SyncWorkflows')
    const { runGit } = await import('../../app/Actions/Git/git')
    const head = (await runGit(created.diskPath, ['rev-parse', 'refs/heads/main'])).stdout.trim()

    const delivery = {
      repositoryId: created.repositoryId,
      owner: created.handle,
      defaultBranch: 'main',
      updates: [{
        kind: 'branch',
        name: 'main',
        change: 'updated',
        ref: 'refs/heads/main',
        before: head,
        after: head,
      }],
    }

    // The count after the *first* delivery is the baseline. Taking it before
    // would be asserting that this head already has a run, which it may not -
    // and then the test would fail on the first delivery doing its job.
    await syncFromPush(delivery)
    const afterFirst = (await runsHere()).length

    await syncFromPush(delivery)

    expect((await runsHere()).length).toBe(afterFirst)
  })

  test('and run numbers are per repository, so a person can say "run 2"', async () => {
    if (!available)
      return

    const runs = await runsHere()
    expect(runs.map(run => Number(run.number))).toEqual(runs.map((_, index) => index + 1))
  })
})
