// `uses: docker://image`, run for real.
//
// The runtime here is a script this test writes, and that is deliberate rather
// than a shortcut: it makes the whole path exercisable on a machine with no
// docker - policy, argv, spawn, streaming, exit code - and it lets the test
// assert the command line that was actually run, which is the part that goes
// wrong silently. A real docker would prove the same thing plus that images can
// be pulled, at the cost of a test that fails on every machine without a daemon.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = { ownerId: 0, repositoryId: 0, runnerId: 0, handle: '', name: '', diskPath: '', temp: '', token: '', headSha: '' }

let available = false
let db: any = null
let serve: any = null
let baseUrl = ''
let recorded = ''
let runtime = ''

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

  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return ''
}

const WORKFLOW = `name: Container
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Publish with an image
        uses: docker://ghcr.io/acme/publish:1.4.0
        with:
          entrypoint: /entry.sh
          args: publish --message "a title with spaces"
          tag: v2
`

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-container-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('ctr')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Container', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'work')
    mkdirSync(join(work, '.reviewos', 'workflows'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    writeFileSync(join(work, '.reviewos', 'workflows', 'container.yml'), WORKFLOW)
    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'a workflow that uses an image')
    await git(work, 'push', created.diskPath, 'main')

    /*
     * The runtime: a script that records what it was asked to run and exits
     * zero. Everything the runner does with it - the flags, the mounts, the
     * environment, the arguments after the image - is what a real docker would
     * have received.
     */
    recorded = join(created.temp, 'argv.txt')
    runtime = join(created.temp, 'fake-docker')

    writeFileSync(runtime, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument" >> ${JSON.stringify(recorded)}; done\necho "publishing from the image"\nexit 0\n`)
    chmodSync(runtime, 0o755)

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${'0'.repeat(40)} ${await headOf(work)} refs/heads/main`),
    })

    const secret = generateToken()
    const runner: any = await db.insertInto('runners')
      .values({
        name: unique('ctr'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: secret.hash,
        labels: 'ubuntu-latest\nself-hosted',
        state: 'active',
        version: '1',
      })
      .returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner?.id)
    created.token = secret.token

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    serve = await route.serve({ port: 0, hostname: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${Number((serve as any)?.port ?? 0)}`

    /*
     * Waited for, because the push path is fire and forget: `push:received` is
     * dispatched and not awaited - a push is answered when the refs have moved,
     * not when CI has been thought about - so a test that claimed immediately
     * would sometimes claim before the run existed. It passed alone and failed
     * beside another suite, which is the worst version of this bug.
     */
    const deadline = Date.now() + 20_000

    while (Date.now() < deadline) {
      const queued = await db
        .selectFrom('workflow_jobs')
        .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
        .select(['workflow_jobs.id as id'])
        .where('workflow_runs.repository_id', '=', created.repositoryId)
        .where('workflow_jobs.state', '=', 'queued')
        .execute()
        .catch(() => [])

      if (queued.length > 0)
        break

      await new Promise(resolve => setTimeout(resolve, 100))
    }

    available = true
  }
  catch (error) {
    console.warn(`[container-actions] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

async function headOf(cwd: string): Promise<string> {
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe' })

  return (await new Response(child.stdout).text()).trim()
}

afterAll(async () => {
  try { serve?.stop?.() }
  catch { /* the process is going away anyway */ }

  try {
    if (created.repositoryId) {
      await db.deleteFrom('workflow_runs').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    }

    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the files still go, below */ }

  if (created.diskPath)
    removeRepositoryDirectory(created.diskPath)

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })

  delete process.env.REVIEWOS_CONTAINER_RUNTIME
})

/** Queue this run again, so each test starts from a job nobody has taken. */
async function requeue(): Promise<void> {
  await db.updateTable('workflow_jobs')
    .set({ state: 'queued', runner_id: null, lease_expires_at: null, started_at: null, finished_at: null })
    .where('workflow_run_id', 'in', db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', created.repositoryId))
    .execute()
    .catch(async () => {
      const runs = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const run of runs) {
        await db.updateTable('workflow_jobs')
          .set({ state: 'queued', runner_id: null, lease_expires_at: null, started_at: null, finished_at: null })
          .where('workflow_run_id', '=', Number(run.id))
          .execute()
      }
    })

  await db.updateTable('workflow_runs')
    .set({ state: 'queued', finished_at: null })
    .where('repository_id', '=', created.repositoryId)
    .execute()
}

describe('a step that names an image', () => {
  test('is refused when this instance has not enabled containers', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    // The closed default. An action is code from somewhere else that a
    // repository's workflow runs here, and an image is the widest form of it.
    const outcome = await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })

    expect(outcome).toBeTruthy()
    expect(outcome!.state).toBe('failed')
    expect(outcome!.reason).toContain('container actions are not enabled')
  }, 180_000)

  test('is refused, by name, when there is no runtime to run it', async () => {
    if (!available)
      return

    await requeue()

    process.env.REVIEWOS_CONTAINER_RUNTIME = join(created.temp, 'no-such-runtime')

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    const outcome = await runOnce({
      baseUrl,
      token: created.token,
      reposRoot: 'storage/repos',
      policy: { allowedHosts: [], defaultHost: null, requirePinnedSha: false, allowContainers: true },
    })

    expect(outcome!.state).toBe('failed')
    // Named rather than "command not found": a machine with no docker is an
    // ordinary machine, and the fix is a sentence rather than a stack trace.
    expect(outcome!.reason).toContain('no container runtime')
  }, 180_000)

  test('and runs, with the workspace mounted and the arguments after the image', async () => {
    if (!available)
      return

    await requeue()

    process.env.REVIEWOS_CONTAINER_RUNTIME = runtime

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    const outcome = await runOnce({
      baseUrl,
      token: created.token,
      reposRoot: 'storage/repos',
      policy: { allowedHosts: [], defaultHost: null, requirePinnedSha: false, allowContainers: true },
    })

    expect(outcome).toBeTruthy()
    expect(outcome!.state).toBe('succeeded')

    const argv = readFileSync(recorded, 'utf8').split('\n').filter(Boolean)

    expect(argv.slice(0, 2)).toEqual(['run', '--rm'])
    expect(argv).toContain('ghcr.io/acme/publish:1.4.0')
    expect(argv[argv.indexOf('--workdir') + 1]).toBe('/github/workspace')
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/entry.sh')

    // The inputs, as environment; `args` and `entrypoint` are the container's
    // rather than inputs of anything.
    expect(argv.some(one => one === 'INPUT_TAG=v2')).toBe(true)
    expect(argv.some(one => one.startsWith('INPUT_ARGS='))).toBe(false)

    // The arguments, split the way a shell would split them and passed as an
    // argv: the space inside the quotes is part of one argument.
    expect(argv.slice(argv.indexOf('ghcr.io/acme/publish:1.4.0') + 1)).toEqual(['publish', '--message', 'a title with spaces'])

    // And the paths a container writes through point inside it, or an action's
    // outputs go to a directory that does not exist and the job goes green with
    // nothing in them.
    const output = argv.find(one => one.startsWith('GITHUB_OUTPUT='))

    expect(String(output)).toContain('/github/workspace/')
  }, 180_000)
})
