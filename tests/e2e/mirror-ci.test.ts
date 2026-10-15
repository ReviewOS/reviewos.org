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
