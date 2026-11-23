// A mirror whose workflows run here, end to end.
//
// The whole path a real upstream commit takes: a commit in an upstream
// repository, the sync job fetching it, the bridge turning what moved into a
// push, the workflow listener, the parser, and the run rows. Each piece is
// tested on its own elsewhere; this is the one that fails when they are all
// correct and not connected - which, for mirrors, was the state of things
// from the day they were added: no mirror had ever registered a workflow.
//
// Plus the two answers that talk to GitHub, against a stubbed fetch: the
// commit status a run posts upstream, and the visibility a new mirror takes.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = {
  ownerId: 0,
  handle: '',
  temp: '',
  upstream: '',
  work: '',
  ci: { repositoryId: 0, mirrorId: 0, diskPath: '', name: '' },
  plain: { repositoryId: 0, mirrorId: 0, diskPath: '', name: '' },
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

/** Commit a file upstream, on a branch, and push it there - not here. */
async function commitUpstream(path: string, contents: string, branch = 'main'): Promise<string> {
  await git(created.work, 'checkout', '-B', branch)
  mkdirSync(join(created.work, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(created.work, path), contents)
  await git(created.work, 'add', '.')
  await git(created.work, 'commit', '-m', `add ${path}`)
  await git(created.work, 'push', created.upstream, branch)
  const head = await git(created.work, 'rev-parse', 'HEAD')
  await git(created.work, 'checkout', 'main')
  return head
}

async function sync(mirrorId: number): Promise<any> {
  const { default: MirrorSyncJob } = await import('../../app/Jobs/MirrorSyncJob')
  const outcome: any = await MirrorSyncJob.handle({ mirrorId })
  if (outcome?.ok === false)
    throw new Error(`the sync did nothing: ${outcome.reason}`)
  return outcome
}

function runsOf(repositoryId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(['workflow_runs.id as id', 'workflow_runs.state as state', 'workflow_runs.event_ref as event_ref', 'workflow_runs.head_sha as head_sha'])
    .where('workflows.repository_id', '=', repositoryId)
    .orderBy('workflow_runs.id')
    .execute()
}

function workflowsOf(repositoryId: number): Promise<any[]> {
  return db.selectFrom('workflows').select(['path', 'state']).where('repository_id', '=', repositoryId).execute()
}

const CI = `name: CI
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`

async function mirrorOf(name: string, runWorkflows: boolean): Promise<{ repositoryId: number, mirrorId: number, diskPath: string, name: string }> {
  const { repositoryPath } = await import('../../app/Actions/Git/storage')
  const { initBare } = await import('../../app/Actions/Git/git')

  const resolved = repositoryPath(created.handle, name)
  const repository: any = await db
    .insertInto('repositories')
    .values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name,
      description: 'created by the mirror CI end to end test',
      visibility: 'private',
      default_branch: 'main',
      disk_path: resolved.path!,
    })
    .returning(['id'])
    .executeTakeFirst()

  mkdirSync(resolve(resolved.path!, '..'), { recursive: true })
  await initBare(resolved.path!, 'main')

  const mirror: any = await db
    .insertInto('repository_mirrors')
    .values({
      repository_id: Number(repository.id),
      direction: 'pull',
      // `git`, not `github`: the upstream is a directory, and a status is
      // only ever posted to GitHub - which the last describe block covers.
      provider: 'git',
      remote_url: created.upstream,
      remote_owner: 'upstream',
      remote_name: name,
      interval_seconds: 60,
      enabled: true,
      run_workflows: runWorkflows,
    })
    .returning(['id'])
    .executeTakeFirst()

  return { repositoryId: Number(repository.id), mirrorId: Number(mirror.id), diskPath: resolved.path!, name }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-mirrorci-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('mci')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Mirror CI', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.upstream = join(created.temp, 'upstream.git')
    await git(created.temp, 'init', '--bare', '--initial-branch=main', created.upstream)

    created.work = join(created.temp, 'work')
    mkdirSync(created.work, { recursive: true })
    await git(created.work, 'init', '--initial-branch=main')
    writeFileSync(join(created.work, 'README.md'), 'first\n')
    mkdirSync(join(created.work, '.github/workflows'), { recursive: true })
    writeFileSync(join(created.work, '.github/workflows/ci.yml'), CI)
    await git(created.work, 'add', '.')
    await git(created.work, 'commit', '-m', 'first')
    await git(created.work, 'push', created.upstream, 'main')

    created.ci = await mirrorOf(unique('ci'), true)
    created.plain = await mirrorOf(unique('plain'), false)

    available = true
  }
  catch (error) {
    console.warn(`[mirror-ci] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of [created.ci.repositoryId, created.plain.repositoryId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch (error) {
    console.warn(`[mirror-ci] fixtures left behind: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const path of [created.ci.diskPath, created.plain.diskPath].filter(Boolean)) {
    removeRepositoryDirectory(path)
    try {
      removeRepositoryOwnerDirectory(path)
    }
    catch { /* another repository of this owner still lives there */ }
  }

  rmSync(created.temp, { recursive: true, force: true })
})

describe('a mirror that runs its workflows', () => {
  test('registers them, and runs the first sync\'s commit as a push', async () => {
    if (!available)
      return

    await sync(created.ci.mirrorId)

    expect((await workflowsOf(created.ci.repositoryId)).map(row => row.path)).toEqual(['.github/workflows/ci.yml'])
    const runs = await runsOf(created.ci.repositoryId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ state: 'queued', event_ref: 'refs/heads/main' })
  })

  test('runs an upstream commit on the next sync', async () => {
    if (!available)
      return

    const head = await commitUpstream('src/next.ts', 'export const next = 1\n')
    await sync(created.ci.mirrorId)

    const runs = await runsOf(created.ci.repositoryId)
    expect(runs.at(-1)).toMatchObject({ event_ref: 'refs/heads/main', head_sha: head })
  })

  test('and a commit to a branch that is not the default one', async () => {
    if (!available)
      return

    // The push listener used to return before dispatching unless the
    // default branch had moved, so this started nothing - for a push or a
    // sync alike.
    const head = await commitUpstream('src/feature.ts', 'export const feature = 1\n', 'feature')
    await sync(created.ci.mirrorId)

    const runs = await runsOf(created.ci.repositoryId)
    expect(runs.at(-1)).toMatchObject({ event_ref: 'refs/heads/feature', head_sha: head })
  })

  test('a sync that finds nothing new starts nothing', async () => {
    if (!available)
      return

    const before = (await runsOf(created.ci.repositoryId)).length
    await sync(created.ci.mirrorId)
    expect((await runsOf(created.ci.repositoryId)).length).toBe(before)
  })
})

describe('a mirror that says which runners stand in for its hosted labels', () => {
  const MATRIX = `name: Matrix
on:
  push:
jobs:
  test:
    name: Test (\${{ matrix.os }})
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - run: zig build test
  distro:
    runs-on: ubuntu-latest
    container: fedora:latest
    steps:
      - run: dnf install -y git
  mine:
    runs-on: [self-hosted, gpu]
    steps:
      - run: nvidia-smi
`

  test('fills the matrix into runs-on, translates it, and skips what nothing here runs', async () => {
    if (!available)
      return

    await db.updateTable('repository_mirrors')
      .set({ runner_labels: 'ubuntu-latest=self-hosted,linux-x64\nwindows-latest=', job_priority: -5 })
      .where('id', '=', created.ci.mirrorId)
      .execute()

    const head = await commitUpstream('.github/workflows/matrix.yml', MATRIX)
    await sync(created.ci.mirrorId)

    // Both workflows ran on this push; their jobs together.
    const jobs: any[] = await db.selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.name as name', 'workflow_jobs.state as state', 'workflow_jobs.runs_on as runs_on', 'workflow_jobs.condition_reason as condition_reason', 'workflow_jobs.priority as priority'])
      .where('workflow_runs.repository_id', '=', created.ci.repositoryId)
      .where('workflow_runs.head_sha', '=', head)
      .execute()
    const byName = new Map(jobs.map(job => [String(job.name), job]))

    // The repository's other workflow is translated the same way.
    expect(byName.get('test')).toMatchObject({ state: 'queued', runs_on: 'self-hosted\nlinux-x64' })

    // `${{ matrix.os }}` used to be stored as written, and asked for a runner
    // labelled with the expression - which no machine ever is.
    expect(byName.get('Test (ubuntu-latest)')).toMatchObject({ state: 'queued', runs_on: 'self-hosted\nlinux-x64' })
    expect(Number(byName.get('Test (ubuntu-latest)').priority)).toBe(-5)

    expect(byName.get('Test (windows-latest)')).toMatchObject({ state: 'skipped' })
    expect(String(byName.get('Test (windows-latest)').condition_reason)).toContain('`windows-latest`')

    expect(byName.get('distro')).toMatchObject({ state: 'skipped' })
    expect(String(byName.get('distro').condition_reason)).toContain('container: fedora:latest')

    // A label the map does not mention means what it meant.
    expect(byName.get('mine')).toMatchObject({ state: 'queued', runs_on: 'self-hosted\ngpu' })

    await db.updateTable('repository_mirrors').set({ runner_labels: null, job_priority: 0 }).where('id', '=', created.ci.mirrorId).execute()

    // Upstream back to the one workflow the tests below expect it to hold.
    await git(created.work, 'checkout', 'main')
    await git(created.work, 'pull', created.upstream, 'main')
    await git(created.work, 'rm', '-q', '.github/workflows/matrix.yml')
    await git(created.work, 'commit', '-m', 'remove the matrix workflow')
    await git(created.work, 'push', created.upstream, 'main')
    await sync(created.ci.mirrorId)
  })

  test('a re-run keeps a skipped combination skipped, and translates the rest from the current map', async () => {
    if (!available)
      return

    // zig-anti-virus #3: `reviewos rerun 3 --all` put the macos-latest
    // combination its map skips back in the queue as `macos-latest`, where it
    // waited for a machine nobody owns until the sweep failed it.
    const FORMATS = `name: Differential
on:
  push:
jobs:
  formats:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: zig build test
`

    await db.updateTable('repository_mirrors')
      .set({ runner_labels: 'macos-latest=\nubuntu-latest=self-hosted,linux-x64' })
      .where('id', '=', created.ci.mirrorId)
      .execute()

    const head = await commitUpstream('.github/workflows/differential.yml', FORMATS)

    try {
      await sync(created.ci.mirrorId)

      const run: any = await db.selectFrom('workflow_runs')
        .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
        .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
        .select(['workflow_runs.id as id'])
        .where('workflow_runs.repository_id', '=', created.ci.repositoryId)
        .where('workflow_runs.head_sha', '=', head)
        .where('workflows.path', '=', '.github/workflows/differential.yml')
        .executeTakeFirst()
      const runId = Number(run.id)

      const jobsOf = async (): Promise<Map<string, any>> => new Map((await db.selectFrom('workflow_jobs')
        .select(['matrix_values', 'state', 'runs_on', 'condition_reason', 'attempt'])
        .where('workflow_run_id', '=', runId)
        .execute()).map((job: any) => [String(JSON.parse(String(job.matrix_values)).os), job]))

      // Finished, the way attempt 1 finished before the re-run.
      const finish = async (): Promise<void> => {
        await db.updateTable('workflow_jobs').set({ state: 'succeeded', finished_at: new Date().toISOString() })
          .where('workflow_run_id', '=', runId).where('state', '=', 'queued').execute()
        await db.updateTable('workflow_runs').set({ state: 'succeeded', finished_at: new Date().toISOString() }).where('id', '=', runId).execute()
      }

      expect((await jobsOf()).get('macos-latest')).toMatchObject({ state: 'skipped' })
      await finish()

      const { rerunRun } = await import('../../app/Actions/Workflow/rerun')
      const first = await rerunRun({ runId, scope: 'all' })
      expect(first.ok).toBe(true)

      let jobs = await jobsOf()
      expect(jobs.get('macos-latest')).toMatchObject({ state: 'skipped', runs_on: 'macos-latest' })
      expect(String(jobs.get('macos-latest').condition_reason)).toContain('`macos-latest`')
      expect(jobs.get('ubuntu-latest')).toMatchObject({ state: 'queued', runs_on: 'self-hosted\nlinux-x64' })

      // The map changed between attempts: the labels follow it, from the
      // workflow's own `ubuntu-latest` rather than from the last attempt's answer.
      await db.updateTable('repository_mirrors')
        .set({ runner_labels: 'macos-latest=\nubuntu-latest=self-hosted,owned-linux' })
        .where('id', '=', created.ci.mirrorId)
        .execute()
      await finish()
      await rerunRun({ runId, scope: 'all' })

      jobs = await jobsOf()
      expect(jobs.get('ubuntu-latest')).toMatchObject({ state: 'queued', runs_on: 'self-hosted\nowned-linux' })
      expect(jobs.get('macos-latest')).toMatchObject({ state: 'skipped' })

      // And a label mapped away since is skipped on the next attempt, with why.
      await db.updateTable('repository_mirrors')
        .set({ runner_labels: 'macos-latest=\nubuntu-latest=' })
        .where('id', '=', created.ci.mirrorId)
        .execute()
      await finish()
      await rerunRun({ runId, scope: 'all' })

      jobs = await jobsOf()
      expect(jobs.get('ubuntu-latest')).toMatchObject({ state: 'skipped', runs_on: 'ubuntu-latest' })
      expect(String(jobs.get('ubuntu-latest').condition_reason)).toContain('`ubuntu-latest`')
    }
    finally {
      await db.updateTable('repository_mirrors').set({ runner_labels: null }).where('id', '=', created.ci.mirrorId).execute()

      // Upstream back to the one workflow the tests below expect it to hold.
      await git(created.work, 'checkout', 'main')
      await git(created.work, 'pull', created.upstream, 'main')
      await git(created.work, 'rm', '-q', '.github/workflows/differential.yml')
      await git(created.work, 'commit', '-m', 'remove the differential workflow')
      await git(created.work, 'push', created.upstream, 'main')
      await sync(created.ci.mirrorId)
    }
  })

  test('and with `intermediate: skip`, a newer commit replaces the run still waiting for a runner', async () => {
    if (!available)
      return

    await db.updateTable('repository_mirrors').set({ intermediate: 'skip' }).where('id', '=', created.ci.mirrorId).execute()

    const first = await commitUpstream('src/one.ts', 'export const one = 1\n')
    await sync(created.ci.mirrorId)
    const second = await commitUpstream('src/two.ts', 'export const two = 2\n')
    await sync(created.ci.mirrorId)

    const runs: any[] = await db.selectFrom('workflow_runs')
      .select(['head_sha', 'state', 'concurrency_group'])
      .where('repository_id', '=', created.ci.repositoryId)
      .where('head_sha', 'in', [first, second])
      .execute()
    const of = (sha: string) => runs.find(run => run.head_sha === sha)

    // Grouped per workflow and ref, although the workflow declares no group.
    expect(String(of(second).concurrency_group)).toBe('mirror:.github/workflows/ci.yml:refs/heads/main')
    expect(of(first).state).toBe('cancelled')
    expect(of(second).state).toBe('queued')

    await db.updateTable('repository_mirrors').set({ intermediate: null }).where('id', '=', created.ci.mirrorId).execute()
  })

  test('and with `intermediate: skip`, a run on an older commit never drops one on a newer commit', async () => {
    if (!available)
      return

    // zig-anti-virus #18: a schedule run on a stale commit (3d46a79) arrived
    // while push run #16 on the branch head (277b359) waited behind a running
    // run, and `skip` cancelled #16 "because a newer commit arrived" - the
    // newer *run* was on the older commit.
    await db.updateTable('repository_mirrors').set({ intermediate: 'skip' }).where('id', '=', created.ci.mirrorId).execute()

    try {
      const older = await commitUpstream('src/four.ts', 'export const four = 4\n')
      await sync(created.ci.mirrorId)
      const ahead = await commitUpstream('src/five.ts', 'export const five = 5\n')
      await sync(created.ci.mirrorId)

      const runOn = async (sha: string, event = 'push'): Promise<any> => db.selectFrom('workflow_runs')
        .select(['id', 'state', 'head_sha', 'concurrency_group'])
        .where('repository_id', '=', created.ci.repositoryId)
        .where('head_sha', '=', sha)
        .where('event', '=', event)
        .orderBy('id', 'desc')
        .executeTakeFirst()
      const stateOf = async (id: number): Promise<string> => String((await db.selectFrom('workflow_runs').select(['state']).where('id', '=', id).executeTakeFirst()).state)

      // The run on `ahead` has started, so the next push waits behind it.
      const running = await runOn(ahead)
      await db.updateTable('workflow_runs').set({ state: 'running', started_at: new Date().toISOString() }).where('id', '=', Number(running.id)).execute()

      const newest = await commitUpstream('src/six.ts', 'export const six = 6\n')
      await sync(created.ci.mirrorId)
      const waiting = await runOn(newest)
      expect(waiting.state).toBe('waiting')

      const version: any = await db.selectFrom('workflow_versions')
        .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
        .select(['workflow_versions.id as id'])
        .where('workflows.repository_id', '=', created.ci.repositoryId)
        .where('workflows.path', '=', '.github/workflows/ci.yml')
        .orderBy('workflow_versions.id', 'desc')
        .executeTakeFirst()
      const { releaseGroup, startRun } = await import('../../app/Actions/Workflow/dispatch')
      const { withRedeliveryKey } = await import('../../app/Actions/Workflow/redelivery')
      const scheduled = (sha: string): Promise<number> => startRun({
        values: withRedeliveryKey({
          workflow_version_id: Number(version.id),
          repository_id: created.ci.repositoryId,
          state: 'queued',
          event: 'schedule',
          event_ref: 'refs/heads/main',
          head_sha: sha,
          definition_sha: sha,
          trusted: true,
          actor_id: null,
          concurrency_group: null,
          started_at: null,
        }),
        versionId: Number(version.id),
      })

      // A run on an older commit arrives: the newer one keeps its place.
      const stale = await scheduled(older)
      expect(await stateOf(Number(waiting.id))).toBe('waiting')
      expect(await stateOf(stale)).toBe('waiting')

      // And one on the same commit is not a newer commit either.
      const same = await scheduled(newest)
      expect(await stateOf(Number(waiting.id))).toBe('waiting')

      // When the running one finishes, the newest commit goes next and the
      // stale run is dropped - not the other way round, as it was by run id.
      await db.updateTable('workflow_runs').set({ state: 'succeeded', finished_at: new Date().toISOString() }).where('id', '=', Number(running.id)).execute()
      const released = await releaseGroup(created.ci.repositoryId, String(waiting.concurrency_group))

      expect([Number(waiting.id), same]).toContain(Number(released))
      expect(await stateOf(Number(released))).toBe('queued')
      expect(await stateOf(stale)).toBe('cancelled')

      // A genuinely newer commit still replaces the waiting run, as before.
      const later = await commitUpstream('src/seven.ts', 'export const seven = 7\n')
      await db.updateTable('workflow_runs').set({ state: 'running', started_at: new Date().toISOString() }).where('id', '=', Number(released)).execute()
      await sync(created.ci.mirrorId)
      const replacing = await runOn(later)
      expect(replacing.state).toBe('waiting')
      const latest = await commitUpstream('src/eight.ts', 'export const eight = 8\n')
      await sync(created.ci.mirrorId)
      expect(await stateOf(Number(replacing.id))).toBe('cancelled')
      expect((await runOn(latest)).state).toBe('waiting')
      await db.updateTable('workflow_runs').set({ state: 'succeeded', finished_at: new Date().toISOString() }).where('id', '=', Number(released)).execute()
    }
    finally {
      await db.updateTable('repository_mirrors').set({ intermediate: null }).where('id', '=', created.ci.mirrorId).execute()
    }
  })

  test('and with `workflows:`, its events start only the workflows it lists', async () => {
    if (!available)
      return

    await db.updateTable('repository_mirrors').set({ workflow_paths: 'nightly.yml' }).where('id', '=', created.ci.mirrorId).execute()

    const head = await commitUpstream('src/three.ts', 'export const three = 3\n')
    await sync(created.ci.mirrorId)

    const runs = await runsOf(created.ci.repositoryId)
    expect(runs.some(run => run.head_sha === head)).toBe(false)

    await db.updateTable('repository_mirrors').set({ workflow_paths: null }).where('id', '=', created.ci.mirrorId).execute()
  })
})

describe('a mirror that does not', () => {
  test('fetches the same commits and registers nothing', async () => {
    if (!available)
      return

    await sync(created.plain.mirrorId)

    expect(await workflowsOf(created.plain.repositoryId)).toEqual([])
    expect(await runsOf(created.plain.repositoryId)).toEqual([])
  })

  test('until it is asked to, when it registers what it already holds', async () => {
    if (!available)
      return

    // Switched on for a mirror that is already current: the next sync finds
    // nothing to fetch, and must still read the definitions it has.
    await db.updateTable('repository_mirrors').set({ run_workflows: true }).where('id', '=', created.plain.mirrorId).execute()
    await sync(created.plain.mirrorId)

    expect((await workflowsOf(created.plain.repositoryId)).map(row => row.path)).toEqual(['.github/workflows/ci.yml'])
    // Definitions, not runs: nothing upstream moved.
    expect(await runsOf(created.plain.repositoryId)).toEqual([])
  })
})

describe('a mirror waiting for its credential', () => {
  test('waits, says what for, and does not count it as a failure', async () => {
    if (!available)
      return

    // A credential named and not yet set: fetching anyway fails on a private
    // repository, and ten of those disabled the mirror for good before anybody
    // could add the token it was waiting for.
    await db.updateTable('repository_mirrors')
      .set({ credential_ref: 'notsetyet', failure_count: 0 })
      .where('id', '=', created.plain.mirrorId)
      .execute()
    delete process.env.MIRROR_TOKEN_NOTSETYET

    const { default: MirrorSyncJob } = await import('../../app/Jobs/MirrorSyncJob')
    const outcome: any = await MirrorSyncJob.handle({ mirrorId: created.plain.mirrorId })

    expect(outcome.ok).toBe(false)
    expect(String(outcome.reason)).toContain('MIRROR_TOKEN_NOTSETYET')

    const row: any = await db.selectFrom('repository_mirrors').select(['failure_count', 'enabled', 'last_error']).where('id', '=', created.plain.mirrorId).executeTakeFirst()
    expect(Number(row.failure_count)).toBe(0)
    expect(Boolean(row.enabled)).toBe(true)
    expect(String(row.last_error)).toContain('waiting for its credential')

    await db.updateTable('repository_mirrors').set({ credential_ref: null }).where('id', '=', created.plain.mirrorId).execute()
  })
})

describe('talking to GitHub', () => {
  test('a run posts its state on the upstream commit, as a status in its workflow\'s name', async () => {
    if (!available)
      return

    const runs = await runsOf(created.ci.repositoryId)
    await db.updateTable('repository_mirrors')
      .set({ provider: 'github', remote_owner: 'acme', remote_name: 'widgets', credential_ref: 'mirrorcitest' })
      .where('id', '=', created.ci.mirrorId)
      .execute()
    process.env.MIRROR_TOKEN_MIRRORCITEST = 'test-token'

    const posted: Array<{ url: string, body: any, auth: string }> = []
    const fetchImpl = (async (url: string, init: any) => {
      posted.push({ url: String(url), body: JSON.parse(init.body), auth: String(init.headers.authorization) })
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch

    const { reportRunUpstream } = await import('../../app/Actions/Mirror/upstreamStatus')
    await reportRunUpstream(created.ci.repositoryId, { id: Number(runs[0].id), number: 1, state: 'succeeded', headSha: String(runs[0].head_sha) }, fetchImpl)

    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe(`https://api.github.com/repos/acme/widgets/statuses/${runs[0].head_sha}`)
    expect(posted[0].auth).toBe('Bearer test-token')
    expect(posted[0].body).toMatchObject({ state: 'success', context: 'ReviewOS / CI', description: 'Run 1 passed' })

    delete process.env.MIRROR_TOKEN_MIRRORCITEST
  })

  test('a concurrency-held run is announced before a runner can claim it', async () => {
    if (!available)
      return

    const [run] = await runsOf(created.ci.repositoryId)
    const { announceNewRuns, updatesFromChanges } = await import('../../app/Actions/Mirror/workflows')
    const updates = updatesFromChanges([{ ref: 'refs/heads/main', before: null, after: String(run.head_sha), kind: 'created' }])
    const posted: any[] = []
    const fetchImpl = (async (url: string, init: any) => {
      posted.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const previousToken = process.env.MIRROR_TOKEN_MIRRORCITEST
    process.env.MIRROR_TOKEN_MIRRORCITEST = 'test-token'

    try {
      await db.updateTable('workflow_runs').set({ state: 'waiting' }).where('id', '=', Number(run.id)).execute()
      await announceNewRuns(created.ci.repositoryId, updates, fetchImpl)

      expect(posted).toHaveLength(1)
      expect(posted[0].url).toBe(`https://api.github.com/repos/acme/widgets/statuses/${run.head_sha}`)
      expect(posted[0].body).toMatchObject({ state: 'pending', context: 'ReviewOS / CI', description: 'Run 1 is waiting' })

      // A later sync must not overwrite a completed verdict with an initial announcement.
      await db.updateTable('workflow_runs').set({ state: 'succeeded' }).where('id', '=', Number(run.id)).execute()
      await announceNewRuns(created.ci.repositoryId, updates, fetchImpl)
      expect(posted).toHaveLength(1)
    }
    finally {
      await db.updateTable('workflow_runs').set({ state: run.state }).where('id', '=', Number(run.id)).execute()
      if (previousToken === undefined)
        delete process.env.MIRROR_TOKEN_MIRRORCITEST
      else
        process.env.MIRROR_TOKEN_MIRRORCITEST = previousToken
    }
  })

  test('and nothing for a mirror that does not run its workflows here', async () => {
    if (!available)
      return

    await db.updateTable('repository_mirrors').set({ run_workflows: false }).where('id', '=', created.ci.mirrorId).execute()

    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch

    const { reportRunUpstream } = await import('../../app/Actions/Mirror/upstreamStatus')
    await reportRunUpstream(created.ci.repositoryId, { id: 1, number: 1, state: 'failed', headSha: 'a'.repeat(40) }, fetchImpl)

    expect(called).toBe(false)
  })

  test('a new mirror is public only when GitHub says the upstream is', async () => {
    const { upstreamVisibility } = await import('../../app/Commands/MirrorAdd')
    const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    const remote = { owner: 'acme', name: 'widgets' }

    expect(await upstreamVisibility(remote, undefined, answering(200, { private: false }))).toBe('public')
    expect(await upstreamVisibility(remote, undefined, answering(200, { private: true }))).toBe('private')
    // No answer is not a "public": a rate limit or a refusal keeps it hidden.
    expect(await upstreamVisibility(remote, undefined, answering(404, { message: 'Not Found' }))).toBe('private')
    expect(await upstreamVisibility(remote, undefined, answering(403, { message: 'rate limited' }))).toBe('private')
  })
})
