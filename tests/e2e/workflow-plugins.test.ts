// Plugins, from a reference in a workflow file to hook scripts in a claim.
//
// Every check here is one the roadmap asks for by name: an unpinned plugin
// under a pinning policy, a parameter the plugin does not declare, a plugin
// outside the allowlist, and a plugin whose hook wants a capability the pool
// does not grant. All four are refusals, and the interesting half of each is
// *where* it happens - three at dispatch, where the job goes red with a
// sentence on it, and the capability one at claim, because which pool a job
// runs in is a fact about the machine that took it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  repositoryId: 0,
  pluginRepositoryId: 0,
  wrapperRepositoryId: 0,
  wrapperName: '',
  wrapperDiskPath: '',
  poolId: 0,
  queueId: 0,
  runnerId: 0,
  policyIds: [] as number[],
  handle: '',
  name: '',
  pluginName: '',
  diskPath: '',
  pluginDiskPath: '',
  temp: '',
  headSha: '',
}

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

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

  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} failed`)

  return stdout
}

let variant = 0

/**
 * A workflow file whose job uses the plugins the caller names.
 *
 * Each one differs by a number in the command, because a version is keyed on
 * the content: two tests that write the same file are one version, and the
 * newest-version rule would then hand the second test the first one's plugins.
 */
function workflow(plugins: string): string {
  variant += 1

  return `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    reviewos:
      plugins:
${plugins}
    steps:
      - run: make ${variant}
`
}

/**
 * Sync a workflow, dispatch a run, and answer with the run's jobs.
 *
 * A fresh commit each time, because the redelivery index is on (version, ref,
 * head, event): two runs of one workflow at one commit are the same run as far
 * as the database is concerned, which is the dedupe working rather than a
 * fixture problem to route around. The commit is empty, so the vendored plugin
 * and the Makefile are still there at every one of them.
 */
async function runWith(source: string): Promise<any[]> {
  const work = join(created.temp, 'seed')

  /*
   * Everything older put to bed first. A claim takes the oldest job it may
   * have, so a queued job from the test before would be handed out instead of
   * this one - and the assertion would be about the wrong run.
   */
  const previous: any[] = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', created.repositoryId).execute()

  if (previous.length > 0) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('state', 'in', ['blocked', 'queued', 'running'])
      .where('workflow_run_id', 'in', previous.map((row: any) => Number(row.id)))
      .execute()
  }

  await git(work, 'commit', '--allow-empty', '-m', `run ${variant}`)
  await git(work, 'push', created.diskPath, 'main')

  created.headSha = (await git(work, 'rev-parse', 'HEAD')).trim()

  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path: '.github/workflows/ci.yml',
    source,
    sha: created.headSha,
  })

  const dispatched = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: created.headSha,
  })

  const runId = Number(dispatched.created[0])

  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'condition_reason', 'settings'])
    .where('workflow_run_id', '=', runId)
    .execute()
}

/** Write a policy row for one scope, remembering it for the cleanup. */
async function policy(scope: 'instance' | 'pool', values: Record<string, unknown>): Promise<void> {
  const row: any = await db
    .insertInto('plugin_policies')
    .values({ scope_type: scope, scope_id: scope === 'pool' ? created.poolId : null, ...values } as any)
    .returning(['id'])
    .executeTakeFirst()

  created.policyIds.push(Number(row.id))
}

async function clearPolicies(): Promise<void> {
  for (const id of created.policyIds)
    await db.deleteFrom('plugin_policies').where('id', '=', id).execute().catch(() => {})

  created.policyIds = []
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.temp = mkdtempSync(join(tmpdir(), 'reviewos-plugins-'))
    created.handle = unique('plg')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Plugins', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)

    /*
     * Two repositories: the one with the workflow, and one that *is* a plugin.
     * The second is the shape the roadmap describes - a versioned,
     * self-contained repository providing hooks and a parameter schema.
     */
    for (const which of ['repository', 'plugin', 'wrapper'] as const) {
      const name = unique(which === 'repository' ? 'repo' : which)
      const resolved = repositoryPath(created.handle, name)

      const row: any = await db.insertInto('repositories').values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      }).returning(['id']).executeTakeFirst()

      mkdirSync(resolve(resolved.path!, '..'), { recursive: true })
      await initBare(resolved.path!, 'main')

      if (which === 'repository') {
        created.name = name
        created.repositoryId = Number(row.id)
        created.diskPath = resolved.path!
      }
      else if (which === 'plugin') {
        created.pluginName = name
        created.pluginRepositoryId = Number(row.id)
        created.pluginDiskPath = resolved.path!
      }
      else {
        created.wrapperName = name
        created.wrapperRepositoryId = Number(row.id)
        created.wrapperDiskPath = resolved.path!
      }
    }

    /*
     * The plugin repository: a manifest, a hook, and a tag. The tag matters -
     * a pinning policy accepts a tag and refuses a branch, and the two are the
     * same string in a workflow file.
     */
    const pluginWork = join(created.temp, 'plugin')

    mkdirSync(join(pluginWork, 'hooks'), { recursive: true })
    await git(pluginWork, 'init', '--initial-branch=main')

    writeFileSync(join(pluginWork, 'plugin.yml'), `name: greeter
description: says hello before the command
hooks: [pre-command]
parameters:
  greeting:
    type: string
    required: true
`)
    writeFileSync(join(pluginWork, 'hooks', 'pre-command'), '#!/bin/sh\necho "$REVIEWOS_PLUGIN_GREETER_GREETING"\n')

    await git(pluginWork, 'add', '.')
    await git(pluginWork, 'commit', '-m', 'the greeter plugin')
    await git(pluginWork, 'tag', 'v1')
    await git(pluginWork, 'push', created.pluginDiskPath, 'main')
    await git(pluginWork, 'push', created.pluginDiskPath, 'v1')

    /*
     * A plugin with no parameters, for the pool to attach: an operator sets no
     * values, so one that needs any cannot be attached at all.
     */
    const wrapperWork = join(created.temp, 'wrapper')

    mkdirSync(join(wrapperWork, 'hooks'), { recursive: true })
    await git(wrapperWork, 'init', '--initial-branch=main')

    writeFileSync(join(wrapperWork, 'plugin.yml'), `name: wrapper
description: what a fleet puts on every job
hooks: [pre-command]
`)
    writeFileSync(join(wrapperWork, 'hooks', 'pre-command'), '#!/bin/sh\necho wrapping\n')

    await git(wrapperWork, 'add', '.')
    await git(wrapperWork, 'commit', '-m', 'the wrapper plugin')
    await git(wrapperWork, 'tag', 'v1')
    await git(wrapperWork, 'push', created.wrapperDiskPath, 'main')
    await git(wrapperWork, 'push', created.wrapperDiskPath, 'v1')

    /*
     * And a second plugin, vendored in the using repository, which declares a
     * capability. A pool that does not grant it refuses the job.
     */
    const work = join(created.temp, 'seed')

    mkdirSync(join(work, '.reviewos', 'plugins', 'digger', 'hooks'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    writeFileSync(join(work, '.reviewos', 'plugins', 'digger', 'plugin.yml'), `name: digger
hooks: [pre-command]
requires: [docker-socket]
`)
    writeFileSync(join(work, '.reviewos', 'plugins', 'digger', 'hooks', 'pre-command'), '#!/bin/sh\necho digging\n')
    writeFileSync(join(work, 'Makefile'), 'all:\n\t@echo built\n')

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'a vendored plugin')
    await git(work, 'push', created.diskPath, 'main')

    created.headSha = (await git(work, 'rev-parse', 'HEAD')).trim()

    const pool: any = await db.insertInto('runner_pools').values({
      name: unique('Plugins'),
      slug: unique('plugins'),
    } as any).returning(['id']).executeTakeFirst()

    created.poolId = Number(pool.id)

    const queue: any = await db.insertInto('runner_queues').values({
      runner_pool_id: created.poolId,
      name: unique('queue'),
      state: 'active',
    } as any).returning(['id']).executeTakeFirst()

    created.queueId = Number(queue.id)

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
      runner_queue_id: created.queueId,
    } as any).returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner.id)

    available = true
  }
  catch (error) {
    console.warn(`[plugins] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    await clearPolicies()

    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute().catch(() => {})
    if (created.poolId)
      await db.deleteFrom('runner_pools').where('id', '=', created.poolId).execute().catch(() => {})
    for (const id of [created.repositoryId, created.pluginRepositoryId, created.wrapperRepositoryId])
      if (id)
        await db.deleteFrom('repositories').where('id', '=', id).execute().catch(() => {})
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }

  for (const path of [created.diskPath, created.pluginDiskPath, created.wrapperDiskPath, created.temp])
    if (path)
      rmSync(path, { recursive: true, force: true })
})

describe('a plugin a workflow names', () => {
  test('is resolved to a commit and stored on the job', async () => {
    if (!available)
      return

    const jobs = await runWith(workflow(`        - ${created.handle}/${created.pluginName}#v1:
            greeting: hello`))

    const job = jobs.find(one => String(one.job_id) === 'build')

    expect(job).toBeTruthy()
    expect(String(job.state)).toBe('queued')

    const settings = JSON.parse(String(job.settings ?? '{}'))

    expect(settings.plugins).toHaveLength(1)
    expect(String(settings.plugins[0].name)).toBe('greeter')
    // A commit rather than the tag it was written as, so a tag moved afterwards
    // does not change what a re-run executes.
    expect(String(settings.plugins[0].sha)).toMatch(/^[0-9a-f]{40}$/)
    expect(settings.plugins[0].values.greeting).toBe('hello')
  }, 120_000)

  test('reaches the machine as hook scripts rather than as a reference', async () => {
    if (!available)
      return

    await runWith(workflow(`        - ${created.handle}/${created.pluginName}#v1:
            greeting: hello`))

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const body: any = await answer.json()

    expect(body.job).toBeTruthy()
    expect(body.job.plugins).toHaveLength(1)
    // The scripts themselves: the machine fetches nothing, so "what ran" stays
    // a question this instance can answer from the row it stored.
    expect(String(body.job.plugins[0].hooks['pre-command'])).toContain('REVIEWOS_PLUGIN_GREETER_GREETING')
    expect(body.job.plugins[0].environment.REVIEWOS_PLUGIN_GREETER_GREETING).toBe('hello')
  }, 120_000)

  test('is refused when a parameter is not one it declares', async () => {
    if (!available)
      return

    const jobs = await runWith(workflow(`        - ${created.handle}/${created.pluginName}#v1:
            greeting: hello
            greetign: hello`))

    const job = jobs.find(one => String(one.job_id) === 'build')

    /*
     * Failed at dispatch rather than at the runner: the answer to "you
     * misspelled it" belongs on the screen where somebody wrote it, not eleven
     * minutes into a run.
     */
    expect(String(job.state)).toBe('failed')
    expect(String(job.condition_reason)).toContain('greetign')
  }, 120_000)
})

describe('the policy', () => {
  test('refuses a plugin that is not on the allowlist', async () => {
    if (!available)
      return

    await policy('instance', { allowlist: `${created.handle}/something-else`, require_pinned: false, capabilities: '' })

    const jobs = await runWith(workflow(`        - ${created.handle}/${created.pluginName}#v1:
            greeting: hello`))

    const job = jobs.find(one => String(one.job_id) === 'build')

    expect(String(job.state)).toBe('failed')
    expect(String(job.condition_reason)).toContain('allowlist')

    await clearPolicies()
  }, 120_000)

  test('refuses a branch when the instance requires pinning, and takes the tag', async () => {
    if (!available)
      return

    await policy('instance', { allowlist: '', require_pinned: true, capabilities: '' })

    const branch = await runWith(workflow(`        - ${created.handle}/${created.pluginName}#main:
            greeting: hello`))

    expect(String(branch.find(one => String(one.job_id) === 'build').state)).toBe('failed')
    expect(String(branch.find(one => String(one.job_id) === 'build').condition_reason)).toContain('pinned')

    // The same policy accepts the tag, which is the half that makes pinning
    // usable: an allowlist of commits nobody can read is not a policy anybody
    // keeps.
    const tagged = await runWith(workflow(`        - ${created.handle}/${created.pluginName}#v1:
            greeting: hello`))

    expect(String(tagged.find(one => String(one.job_id) === 'build').state)).toBe('queued')

    await clearPolicies()
  }, 120_000)

  test('refuses a plugin that wants a capability the pool does not grant, at the claim', async () => {
    if (!available)
      return

    const jobs = await runWith(workflow('        - ./.reviewos/plugins/digger'))
    const before = jobs.find(one => String(one.job_id) === 'build')

    // Dispatch cannot answer this one: which pool a job runs in is a fact about
    // the machine that claims it, and no machine has yet.
    expect(String(before.state)).toBe('queued')

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const body: any = await answer.json()

    // No work for this machine, and the job is red with the reason rather than
    // sitting in the queue looking like something a runner will get to.
    expect(body.job).toBeNull()

    const after: any = await db
      .selectFrom('workflow_jobs')
      .select(['state', 'condition_reason'])
      .where('id', '=', Number(before.id))
      .executeTakeFirst()

    expect(String(after.state)).toBe('failed')
    expect(String(after.condition_reason)).toContain('docker-socket')
  }, 120_000)

  test('and runs it once the pool grants that capability', async () => {
    if (!available)
      return

    await policy('pool', { allowlist: '', require_pinned: false, capabilities: 'docker-socket' })

    await runWith(workflow('        - ./.reviewos/plugins/digger'))

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const body: any = await answer.json()

    expect(body.job).toBeTruthy()
    expect(body.job.plugins[0].name).toBe('digger')

    await clearPolicies()
  }, 120_000)
})

describe('a plugin attached to a pool', () => {
  test('runs for a job whose workflow never mentioned it', async () => {
    if (!available)
      return

    /*
     * The case an action structurally cannot cover: a fleet that has to wrap
     * every command without that being written into four hundred workflow
     * files, and without a repository being able to remove it.
     */
    await db
      .updateTable('runner_pools')
      .set({ plugins: `${created.handle}/${created.wrapperName}#v1` } as any)
      .where('id', '=', created.poolId)
      .execute()

    await runWith(`name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make plain-${Date.now()}
`)

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const body: any = await answer.json()

    expect(body.job).toBeTruthy()
    expect(body.job.plugins.map((one: any) => one.name)).toEqual(['wrapper'])
    expect(String(body.job.plugins[0].hooks['pre-command'])).toContain('wrapping')

    await db.updateTable('runner_pools').set({ plugins: '' } as any).where('id', '=', created.poolId).execute()
  }, 120_000)

  test('cannot be one that needs parameters, because a pool has nowhere to put them', async () => {
    if (!available)
      return

    await db
      .updateTable('runner_pools')
      .set({ plugins: `${created.handle}/${created.pluginName}#v1` } as any)
      .where('id', '=', created.poolId)
      .execute()

    const jobs = await runWith(`name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make bare-${Date.now()}
`)

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    expect((await answer.json() as any).job).toBeNull()

    /*
     * Said plainly rather than run with an empty value, which is how a
     * profiler ends up writing to `/`.
     */
    const after: any = await db
      .selectFrom('workflow_jobs')
      .select(['state', 'condition_reason'])
      .where('id', '=', Number(jobs.find(one => String(one.job_id) === 'build').id))
      .executeTakeFirst()

    expect(String(after.state)).toBe('failed')
    expect(String(after.condition_reason)).toContain('parameters a pool cannot give it')

    await db.updateTable('runner_pools').set({ plugins: '' } as any).where('id', '=', created.poolId).execute()
  }, 120_000)
})
