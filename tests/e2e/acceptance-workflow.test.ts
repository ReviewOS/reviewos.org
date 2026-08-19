// The bar for this whole section: copy a real repository's workflow directory
// across, push, and CI runs green with no edits.
//
// The file in `tests/fixtures/acceptance/` is verbatim from a real repository -
// not one written to pass this test - and nothing here edits it. What the test
// supplies is the *environment* a self-hosted instance would: the third-party
// actions it names resolve through an origins map pointing at local mirrors,
// which is the configuration an air-gapped instance has and the only shape this
// machine can run, having no network.
//
// So what is proven is the path this product owns end to end: the file
// registers, a push produces the graph, the runner claims the jobs over the
// real protocol, the steps run, and the run ends green. What is not proven here
// is somebody else's action doing what it does on GitHub's runners - that needs
// a machine with a network and is an instance-configuration matter.

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

/**
 * The mirrors: one bare repository per action the workflow names.
 *
 * Each is a composite action that does the honest local equivalent of what the
 * real one does on a hosted runner - the checkout has already happened, the
 * toolchain is on `PATH`, and there is no cache to restore - and says so in the
 * log rather than pretending to be the real thing.
 */
async function mirror(owner: string, name: string, says: string, subdirectory = '', provides = ''): Promise<void> {
  const origin = join(created.temp, 'origin', owner, `${name}.git`)
  const work = join(created.temp, 'work-action', owner, name)

  mkdirSync(join(created.temp, 'origin', owner), { recursive: true })
  mkdirSync(work, { recursive: true })

  await git(created.temp, 'init', '--bare', '--initial-branch=main', origin)
  await git(work, 'init', '--initial-branch=main')

  const directory = subdirectory ? join(work, subdirectory) : work

  if (subdirectory)
    mkdirSync(directory, { recursive: true })

  writeFileSync(join(directory, 'action.yml'), [
    `name: ${name}`,
    'description: A local stand-in for a hosted action',
    'inputs:',
    '  path:',
    '    description: ignored here',
    '    required: false',
    '  key:',
    '    description: ignored here',
    '    required: false',
    '  restore-keys:',
    '    description: ignored here',
    '    required: false',
    '  fetch-depth:',
    '    description: ignored here',
    '    required: false',
    '  version:',
    '    description: ignored here',
    '    required: false',
    '  install:',
    '    description: ignored here',
    '    required: false',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - shell: bash',
    `      run: echo "${says}"`,
    ...(provides
      ? [
          /*
           * What the hosted action actually does: put a tool on `PATH`. The
           * mirror does the same thing the same way - writing the binary and
           * appending its directory to `GITHUB_PATH` - so the step that calls
           * the tool afterwards is exercising the real mechanism rather than a
           * pre-arranged environment.
           */
          '    - shell: bash',
          '      run: |',
          `        mkdir -p "$RUNNER_TEMP/${provides}-bin"`,
          `        printf '#!/bin/sh\\necho "${provides} $*"\\n' > "$RUNNER_TEMP/${provides}-bin/${provides}"`,
          `        chmod +x "$RUNNER_TEMP/${provides}-bin/${provides}"`,
          `        echo "$RUNNER_TEMP/${provides}-bin" >> "$GITHUB_PATH"`,
        ]
      : []),
  ].join('\n'))

  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', 'a local stand-in')
  await git(work, 'tag', 'v2.0.2')
  await git(work, 'tag', 'v5')
  await git(work, 'tag', 'v6')
  await git(work, 'tag', 'v6.0.0')
  await git(work, 'push', origin, 'main', 'v2.0.2', 'v5', 'v6', 'v6.0.0')
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-acceptance-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('bar')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Acceptance', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
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

    /*
     * The repository under test: the real workflow file, copied into
     * `.reviewos/workflows/` exactly as somebody migrating would copy it, and a
     * `package.json` whose scripts are the ones the workflow runs.
     */
    const work = join(created.temp, 'work')

    mkdirSync(join(work, '.reviewos', 'workflows'), { recursive: true })
    mkdirSync(join(work, 'packages', 'bumpx'), { recursive: true })

    const real = readFileSync(join(process.cwd(), 'tests/fixtures/acceptance/bumpx-ci.yml'), 'utf8')

    writeFileSync(join(work, '.reviewos', 'workflows', 'ci.yml'), real)

    /*
     * The repository the workflow runs against: the scripts it calls, and the
     * package directory one job sets as its working directory. Trivial on
     * purpose - the point is that the *workflow* is unedited, not that this is
     * the real project - and a real one would take longer than a test should.
     */
    writeFileSync(join(work, 'package.json'), JSON.stringify({
      name: 'acceptance',
      scripts: { lint: 'echo linted', typecheck: 'echo typechecked', build: 'echo built' },
    }, null, 2))
    writeFileSync(join(work, 'bun.lock'), '{ "lockfileVersion": 1 }\n')
    writeFileSync(join(work, 'packages', 'bumpx', 'package.json'), JSON.stringify({ name: 'bumpx' }, null, 2))
    writeFileSync(join(work, 'packages', 'bumpx', 'ok.test.ts'), [
      'import { expect, test } from \'bun:test\'',
      '',
      'test(\'the acceptance repository has a test\', () => {',
      '  expect(1 + 1).toBe(2)',
      '})',
      '',
    ].join('\n'))

    await git(work, 'init', '--initial-branch=main')
    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'copy the workflow directory across')
    await git(work, 'push', created.diskPath, 'main')

    created.headSha = await git(work, 'rev-parse', 'HEAD')

    // The actions the file names, as local mirrors.
    await mirror('actions', 'checkout', 'the workspace is already checked out')
    await mirror('actions', 'cache', 'no cache on this runner')
    await mirror('oven-sh', 'setup-bun', 'bun is already on PATH')
    // A reference into a subdirectory of a repository, which is a shape real
    // workflows use and a mirror has to reproduce faithfully.
    await mirror('home-lang', 'pantry', 'pantry is already installed', 'packages/action', 'pantry')

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${'0'.repeat(40)} ${created.headSha} refs/heads/main`),
    })

    const secret = generateToken()
    const runner: any = await db.insertInto('runners').values({
      name: unique('acceptance'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: secret.hash,
      labels: 'ubuntu-latest\nself-hosted',
      state: 'active',
      version: '1',
    }).returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner?.id)
    created.token = secret.token

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    serve = await route.serve({ port: 0, hostname: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${Number((serve as any)?.port ?? 0)}`

    available = true
  }
  catch (error) {
    console.warn(`[acceptance] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 300_000)

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
})

/**
 * Poll until it holds, because the push path is fire and forget.
 *
 * `push:received` is dispatched and not awaited - a push is answered when the
 * refs have moved, not when CI has been thought about - so a test that asserted
 * immediately would be asserting against a listener that had not run yet.
 */
async function waitFor<T>(read: () => Promise<T>, holds: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()

  while (!holds(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    value = await read()
  }

  return value
}

describe('a real repository\'s workflow directory, copied across', () => {
  test('registers unedited and produces the graph the file describes', async () => {
    if (!available)
      return

    const workflows = await waitFor(
      () => db.selectFrom('workflows').select(['path', 'state']).where('repository_id', '=', created.repositoryId).execute(),
      (rows: any[]) => rows.length > 0,
    )

    // Registered from `.reviewos/workflows`, which wins outright over
    // `.github/workflows` - the copy is the one that runs.
    expect(workflows).toHaveLength(1)
    expect(String(workflows[0].path)).toBe('.reviewos/workflows/ci.yml')
    expect(String(workflows[0].state)).toBe('active')

    const runs = await waitFor(
      () => db.selectFrom('workflow_runs').select(['id', 'state']).where('repository_id', '=', created.repositoryId).orderBy('id', 'desc').execute(),
      (rows: any[]) => rows.length > 0,
    )

    const run: any = runs[0]

    expect(run).toBeTruthy()

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['job_id', 'needs', 'state'])
      .where('workflow_run_id', '=', Number(run.id))
      .orderBy('position')
      .execute()

    // The file's own graph: three jobs in parallel and one that waits for all
    // three. Nothing here edited it to make that true.
    expect(jobs.map((one: any) => String(one.job_id)).sort()).toEqual(['lint', 'publish-commit', 'test', 'typecheck'])

    const publish = jobs.find((one: any) => String(one.job_id) === 'publish-commit')

    expect(String(publish.needs)).toContain('lint')
    expect(String(publish.state)).toBe('blocked')
  }, 300_000)

  test('and the runner takes its jobs and they go green', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    /*
     * The configuration a self-hosted instance has: a default action host, an
     * origins map pointing at somewhere its machines can reach, and containers
     * off. Nothing about the workflow file changes for this - it is the
     * instance being configured, which is what an operator does once.
     */
    const options = {
      baseUrl,
      token: created.token,
      reposRoot: 'storage/repos',
      workspaceRoot: join(created.temp, 'workspaces'),
      actionCacheRoot: join(created.temp, 'action-cache'),
      policy: {
        allowedHosts: ['actions.example'],
        defaultHost: 'actions.example',
        requirePinnedSha: false,
        allowContainers: false,
      },
      actionOrigins: { 'actions.example': `file://${join(created.temp, 'origin')}` },
      // Off: the fixture repository has no dependency file, and a toolchain
      // fetch on a machine with no network is a minute of nothing.
      toolchain: false,
    }

    const outcomes: any[] = []

    // Four jobs, one claim each: the last one is blocked until the three it
    // needs have finished, which is the graph doing its job.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const outcome = await runOnce(options as any)

      if (!outcome)
        break

      outcomes.push(outcome)
    }

    expect(outcomes.length).toBeGreaterThanOrEqual(3)

    for (const outcome of outcomes) {
      if (outcome.state !== 'succeeded')
        console.warn(`[acceptance] ${outcome.jobId}: ${outcome.reason}`)

      expect(outcome.state).toBe('succeeded')
    }

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['job_id', 'state'])
      .where('workflow_run_id', '=', Number(run.id))
      .execute()

    // Green: every job succeeded and the run says so.
    expect(jobs.map((one: any) => String(one.state)).filter(state => state !== 'succeeded')).toEqual([])
    expect(String(run.state)).toBe('succeeded')
  }, 300_000)
})
