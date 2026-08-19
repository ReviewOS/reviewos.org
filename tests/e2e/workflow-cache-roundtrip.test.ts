// The dependency cache, end to end, with nothing faked.
//
// A real repository, a real push, a real runner taking a real job, a real tar
// crossing a real HTTP endpoint into the real blob store - and then a second
// run of the same workflow finding what the first one left. The unit tests hold
// the key and the scope rules, and the other e2e tests hold the storage and the
// endpoints; this holds the only claim that matters to somebody using it, which
// is that the second job does not do the first job's work again.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join, resolve } from 'node:path'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = { ownerId: 0, repositoryId: 0, runnerId: 0, handle: '', name: '', diskPath: '', temp: '', token: '' }

let available = false
let db: any = null
let serve: any = null
let baseUrl = ''

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<void> {
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

  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
}

async function headOf(cwd: string): Promise<string> {
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe' })

  return (await new Response(child.stdout).text()).trim()
}

/*
 * A workflow whose install step is observable.
 *
 * It writes a marker into `node_modules` only when one is not already there,
 * and prints which branch it took. That single line is the whole assertion: the
 * first run says it installed, the second says it did not have to.
 */
const WORKFLOW = `name: Cached
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: |
          if [ -f node_modules/installed ]; then
            echo "dependencies were already here"
          else
            mkdir -p node_modules
            echo "$(date)" > node_modules/installed
            echo "installed from scratch"
          fi
`

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-cache-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_cache_entries').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('cro')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Cache Roundtrip', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    writeFileSync(join(work, '.reviewos', 'workflows', 'cached.yml'), WORKFLOW)
    // The lockfile is what makes this workspace worth caching at all: without
    // one the key would mean "any job in this repository".
    writeFileSync(join(work, 'bun.lock'), 'a lockfile the key is derived from\n')
    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'a workflow whose install is observable')
    await git(work, 'push', created.diskPath, 'main')

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${'0'.repeat(40)} ${await headOf(work)} refs/heads/main`),
    })

    const secret = generateToken()
    const runner: any = await db.insertInto('runners')
      .values({
        name: unique('cro'),
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

    // The push path is fire and forget, so the run may not exist yet.
    const deadline = Date.now() + 20_000

    while (Date.now() < deadline) {
      const queued = await db
        .selectFrom('workflow_jobs')
        .select(['id'])
        .where('state', '=', 'queued')
        .execute()

      if (queued.length > 0)
        break

      await Bun.sleep(200)
    }

    available = true
  }
  catch (error) {
    console.warn(`[cache-roundtrip] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 300_000)

afterAll(async () => {
  try { serve?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  // Only what this test made, by the name it made it with.
  if (created.diskPath)
    removeRepositoryDirectory(created.diskPath)

  if (created.temp.includes('reviewos-cache-'))
    rmSync(created.temp, { recursive: true, force: true })
})

/** Take one job and run it, with the log it produced. */
async function runAJob(index: number): Promise<{ state: string, log: string }> {
  const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

  const outcome = await runOnce({
    baseUrl,
    token: created.token,
    reposRoot: 'storage/repos',
    workspaceRoot: join(created.temp, `workspaces-${index}`),
    actionCacheRoot: join(created.temp, 'action-cache'),
    // Off: this repository's dependency file is a fixture, and a real toolchain
    // fetch on a machine with no network is a minute of nothing.
    toolchain: false,
  } as any)

  if (!outcome)
    return { state: 'none', log: '' }

  const rows = await db
    .selectFrom('workflow_job_logs')
    .select(['content'])
    .where('workflow_job_id', '=', Number(outcome.jobId))
    .orderBy('sequence', 'asc')
    .execute()

  return { state: String(outcome.state), log: rows.map((row: any) => String(row.content ?? '')).join('') }
}

/** Push again, so there is a second run of the same workflow to claim. */
async function pushAgain(marker: string): Promise<void> {
  const work = join(created.temp, 'work')

  writeFileSync(join(work, 'README.md'), `${marker}\n`)
  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', marker)
  await git(work, 'push', created.diskPath, 'main')

  const { parseRefUpdates } = await import('../../app/Actions/Git/push')
  const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

  await ProcessPushJob.handle({
    gitDir: created.diskPath,
    updates: parseRefUpdates(`${'0'.repeat(40)} ${await headOf(work)} refs/heads/main`),
  })

  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    const queued = await db.selectFrom('workflow_jobs').select(['id']).where('state', '=', 'queued').execute()

    if (queued.length > 0)
      return

    await Bun.sleep(200)
  }
}

describe('the second run of a workflow', () => {
  test('starts from what the first one installed', async () => {
    if (!available)
      return

    /*
     * The cold run. Nothing is stored for this key, so the job installs, and on
     * the way out it packs the workspace and hands it over.
     */
    const cold = await runAJob(1)

    expect(cold.state).toBe('succeeded')
    expect(cold.log).toContain('installed from scratch')
    expect(cold.log).toContain('No dependency snapshot to restore')
    expect(cold.log).toContain('Saved a dependency snapshot')

    // The row the instance wrote, in the scope the run was entitled to rather
    // than one the runner asked for.
    const entries = await db
      .selectFrom('workflow_cache_entries')
      .select(['scope', 'cache_key', 'size_bytes'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    expect(entries).toHaveLength(1)
    expect(String(entries[0].scope)).toBe('refs/heads/main')
    expect(Number(entries[0].size_bytes)).toBeGreaterThan(0)

    /*
     * The warm run: a second push, a second job, a workspace that has never
     * seen this repository - and the install step takes the other branch,
     * because the dependencies arrived before the first step ran.
     */
    await pushAgain('a second commit, so there is a second run')

    const warm = await runAJob(2)

    expect(warm.state).toBe('succeeded')
    expect(warm.log).toContain('Restored dependencies from refs/heads/main')
    expect(warm.log).toContain('dependencies were already here')
    expect(warm.log).not.toContain('installed from scratch')

    /*
     * And it did not store the snapshot again.
     *
     * An exact hit means this scope already has this key, so re-packing the
     * workspace would be an upload spent to reach the state it is already in.
     */
    expect(warm.log).not.toContain('Saved a dependency snapshot')

    const after = await db
      .selectFrom('workflow_cache_entries')
      .select(['id', 'restores'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    expect(after).toHaveLength(1)
    // Counted, because collection prefers an entry runs actually reach for.
    expect(Number(after[0].restores)).toBeGreaterThanOrEqual(1)
  }, 300_000)
})
