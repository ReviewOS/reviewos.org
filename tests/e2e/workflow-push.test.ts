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

  /*
   * The migration this product asks somebody to make: copy the directory
   * across, keep the original for GitHub, and do not have every job run twice.
   *
   * `.reviewos/workflows` wins outright when it exists rather than merging with
   * `.github/workflows`, because merging means a workflow running twice under
   * two names the day somebody forgets to delete one - and "which of these two
   * files ran" is a question nobody should have to ask.
   */
  test('a repository that copies its workflows across runs the copy, not both', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/ci.yml', CI.replace('name: CI', 'name: CI here'))

    const registered = await waitFor(
      workflowsHere,
      (rows: any[]) => rows.some(row => String(row.path).startsWith('.reviewos/')),
    )

    const paths = registered.map((workflow: any) => workflow.path)

    expect(paths).toContain('.reviewos/workflows/ci.yml')

    // The GitHub one is still in the tree and is no longer read: its workflow
    // row stays as it was, and nothing new arrives from it.
    const active = registered.filter((workflow: any) => String(workflow.state) === 'active')

    expect(active.map((workflow: any) => workflow.path)).toEqual(['.reviewos/workflows/ci.yml'])
  })

  /*
   * Deleting a workflow used to leave its row active forever, so a repository
   * that removed its CI kept a definition nobody could find in the tree - and
   * dispatch reads `state = 'active'`, so it kept starting runs from it.
   */
  test('and deleting the file retires the workflow rather than leaving it running', async () => {
    if (!available)
      return

    const work = join(created.temp, 'work')

    rmSync(join(work, '.reviewos'), { recursive: true, force: true })
    rmSync(join(work, '.github'), { recursive: true, force: true })

    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'remove the workflows')

    const before = await git(work, 'rev-parse', 'HEAD~1')
    await git(work, 'push', created.diskPath, 'main')
    const after = await git(work, 'rev-parse', 'HEAD')

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${before} ${after} refs/heads/main`),
    })

    const rows = await waitFor(
      workflowsHere,
      (all: any[]) => all.every(workflow => String(workflow.state) !== 'active'),
    )

    // The rows stay - the runs they produced have to remain inspectable - and
    // none of them is active any more.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((workflow: any) => workflow.state)).not.toContain('active')
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

  /*
   * The rule everybody relies on and nobody checks until it is wrong: a push
   * that only touches documentation starts nothing. The filter had been parsed
   * and dropped, so `paths-ignore` did nothing at all - which is the failure
   * this product names Gitea for elsewhere in the roadmap.
   */
  test('a docs-only push does not start a run when the workflow ignores docs', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/ci.yml', `name: CI
on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`)

    /*
     * Let the workflow push's own run land before taking the baseline.
     *
     * `dispatch` is fire-and-forget, so reading the count immediately after a
     * push measures a moment when the run may not exist yet - and then the
     * *next* settle window catches it and reads as the docs push having
     * started something.
     */
    await new Promise(resolve => setTimeout(resolve, 1500))
    const before = (await runsHere()).length

    await push('docs/guide.md', '# a guide\n')

    // Nothing new should arrive, so there is nothing to wait for: settle long
    // enough that a run which was going to appear has.
    await new Promise(resolve => setTimeout(resolve, 1500))

    expect((await runsHere()).length).toBe(before)

    // And a source change on the same workflow still runs, so the assertion
    // above is about the filter rather than about runs having stopped.
    await push('app/thing.ts', 'export const thing = 2\n')

    const after = await waitFor(runsHere, (rows: any[]) => rows.length > before)

    expect(after.length).toBeGreaterThan(before)
    // Three pushes and two settle windows: past bun's five-second default.
  }, 30_000)

  /*
   * A matrix of four is four jobs in the run, not one job that somehow ran four
   * times: they succeed and fail separately, they go to different runners, and
   * a person looking at a failed run needs to see which combination broke. The
   * expansion existed in the parser and was dropped on the way to the run.
   *
   * Triggered on a path of its own so it does not change what the tests above
   * observe - a second workflow that runs on every push would start a run
   * during the docs-only assertion and read as that filter being broken.
   */
  test('a matrix job becomes one job per combination, named the way Actions names them', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/matrix.yml', `name: Matrix
on:
  push:
    paths:
      - 'matrix/**'
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
        os: [ubuntu, macos]
    steps:
      - run: bun test
`)

    await push('matrix/trigger.txt', 'go\n')

    // The run belonging to *this* workflow, rather than the last one written:
    // the repository has more than one workflow by now.
    const findRun = async () => {
      const rows: any[] = await db
        .selectFrom('workflow_runs')
        .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
        .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
        .select(['workflow_runs.id as id'])
        .where('workflows.path', '=', '.reviewos/workflows/matrix.yml')
        .orderBy('workflow_runs.id', 'desc')
        .execute()

      return rows[0] ?? null
    }

    const run = await waitFor(findRun, (row: any) => Boolean(row))

    expect(run).toBeTruthy()

    const jobs = await waitFor(
      () => db.selectFrom('workflow_jobs').select(['name', 'matrix_values', 'state'])
        .where('workflow_run_id', '=', Number((run as any).id)).orderBy('position').execute(),
      (rows: any[]) => rows.length >= 4,
    )

    expect(jobs).toHaveLength(4)
    expect(jobs.map((job: any) => job.name)).toEqual([
      'test (20, ubuntu)',
      'test (20, macos)',
      'test (22, ubuntu)',
      'test (22, macos)',
    ])

    // And each carries its own values, so a runner has something to inject and
    // the screen has something to show.
    expect(JSON.parse(String(jobs[0].matrix_values))).toEqual({ node: 20, os: 'ubuntu' })
    // Two pushes, each a commit and a job run.
  }, 30_000)

  /*
   * `concurrency:` with `cancel-in-progress`, which is the key the roadmap
   * names Gitea for accepting and ignoring. Push twice and the first run has to
   * stop: a branch that keeps every superseded run alive spends its runners on
   * commits nobody is waiting for.
   *
   * `cancelling` rather than `cancelled` - a run that has been handed to a
   * runner has to be told and has to acknowledge, and the control plane does
   * not get to claim an outcome it cannot observe.
   */
  test('a second push cancels the run its workflow said to replace', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/deploy.yml', `name: Deploy
on:
  push:
    paths:
      - 'deploy/**'
concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: bun run deploy
`)

    const runsFor = async (): Promise<any[]> => db
      .selectFrom('workflow_runs')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_runs.id as id', 'workflow_runs.state as state', 'workflow_runs.concurrency_group as concurrency_group'])
      .where('workflows.path', '=', '.reviewos/workflows/deploy.yml')
      .orderBy('workflow_runs.id')
      .execute()

    await push('deploy/one.txt', 'one\n')
    const first = await waitFor(runsFor, (rows: any[]) => rows.length >= 1)

    expect(first).toHaveLength(1)
    // The group was resolved against this event rather than stored as written.
    expect(first[0].concurrency_group).toBe('deploy-refs/heads/main')

    await push('deploy/two.txt', 'two\n')
    const both = await waitFor(runsFor, (rows: any[]) => rows.length >= 2)

    expect(both).toHaveLength(2)
    expect(both[0].state).toBe('cancelling')
    // And the one that superseded it is untouched.
    expect(both[1].state).toBe('queued')
  }, 30_000)

  test('a workflow without concurrency keeps both runs', async () => {
    if (!available)
      return

    // The default, and the reason cancelling is opt-in: throwing away a run
    // somebody is watching because a colleague pushed is worse than paying for
    // two runners.
    const runsFor = async (): Promise<any[]> => db
      .selectFrom('workflow_runs')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_runs.state as state', 'workflow_runs.concurrency_group as concurrency_group'])
      .where('workflows.path', '=', '.reviewos/workflows/matrix.yml')
      .orderBy('workflow_runs.id')
      .execute()

    await push('matrix/again.txt', 'again\n')

    const rows = await waitFor(runsFor, (list: any[]) => list.length >= 2)

    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((row: any) => row.state === 'queued')).toBe(true)
    expect(rows.every((row: any) => row.concurrency_group === null)).toBe(true)
  }, 30_000)

  /*
   * A job's own `concurrency`, which is the case the workflow level cannot
   * express: a workflow whose runs may overlap, with one deployment job inside
   * it that must not.
   */
  test('a job with its own group cancels the job it replaces, and leaves its siblings alone', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/ship.yml', `name: Ship
on:
  push:
    paths:
      - 'ship/**'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: ship-\${{ github.ref_name }}
      cancel-in-progress: true
    steps:
      - run: ./deploy
`)

    const jobsFor = async (): Promise<any[]> => db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select([
        'workflow_jobs.id as id',
        'workflow_jobs.job_id as job_id',
        'workflow_jobs.state as state',
        'workflow_jobs.concurrency_group as concurrency_group',
      ])
      .where('workflows.path', '=', '.reviewos/workflows/ship.yml')
      .orderBy('workflow_jobs.id')
      .execute()

    await push('ship/one.txt', 'one\n')
    const first = await waitFor(jobsFor, (rows: any[]) => rows.length >= 2)

    expect(first).toHaveLength(2)
    expect(first.find((job: any) => job.job_id === 'deploy').concurrency_group).toBe('ship-main')
    // The job that did not ask for a group does not get one.
    expect(first.find((job: any) => job.job_id === 'test').concurrency_group).toBeNull()

    await push('ship/two.txt', 'two\n')
    const both = await waitFor(jobsFor, (rows: any[]) => rows.length >= 4)

    const deploys = both.filter((job: any) => job.job_id === 'deploy')
    const tests = both.filter((job: any) => job.job_id === 'test')

    // The first deploy is superseded; the second is not.
    expect(deploys[0].state).toBe('cancelling')
    expect(deploys[1].state).toBe('queued')

    // And the sibling job, which asked for nothing, is untouched by any of it.
    expect(tests.every((job: any) => job.state === 'queued')).toBe(true)
  }, 30_000)

  /*
   * `if:` on a job, decided when the run is created rather than left to the
   * execution plane. A run showing three queued jobs that only ever runs one is
   * a run nobody can plan around.
   */
  test('a job whose condition is false is skipped, with the reason recorded', async () => {
    if (!available)
      return

    await push('.reviewos/workflows/conditional.yml', `name: Conditional
on:
  push:
    paths:
      - 'conditional/**'
jobs:
  always:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
  only-tags:
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/')
    steps:
      - run: ./release
  only-main:
    runs-on: ubuntu-latest
    if: github.ref_name == 'main'
    steps:
      - run: ./deploy
`)

    await push('conditional/go.txt', 'go\n')

    const jobsFor = async (): Promise<any[]> => db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select([
        'workflow_jobs.job_id as job_id',
        'workflow_jobs.state as state',
        'workflow_jobs.condition as condition',
        'workflow_jobs.condition_reason as condition_reason',
      ])
      .where('workflows.path', '=', '.reviewos/workflows/conditional.yml')
      .orderBy('workflow_jobs.id')
      .execute()

    const jobs = await waitFor(jobsFor, (rows: any[]) => rows.length >= 3)

    const byId = new Map(jobs.map((job: any) => [job.job_id, job]))

    // No condition: queued, as it always was.
    expect(byId.get('always').state).toBe('queued')

    // A push to a branch is not a tag, so this one never runs and says so.
    expect(byId.get('only-tags').state).toBe('skipped')
    expect(String(byId.get('only-tags').condition_reason)).toContain('false')

    // And the one whose condition holds is queued like any other.
    expect(byId.get('only-main').state).toBe('queued')
    expect(String(byId.get('only-main').condition)).toBe("github.ref_name == 'main'")
  }, 30_000)
})
