// Mirroring the actions a repository uses, and serving them back.
//
// Two problems with one answer: a fleet of runners each fetching
// `actions/checkout@v4` is the same clone happening ten times, and an instance
// whose upstream host is unreachable is an instance where nothing builds. The
// test closes the loop - mirror from an origin, serve over this instance's own
// git routes, and fetch it back with the *upstream gone* - because a cache that
// only works while the thing it caches is reachable is not a cache.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { mirrorAction, usedActions } from '../../app/Actions/Actions/mirror'
import { actionPath, isMirrored } from '../../app/Actions/Actions/store'

const state = { temp: '', origin: '', store: '', sha: '' }

let db: any = null
let serve: any = null
let baseUrl = ''
let available = false

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, jobId: 0, handle: '' }

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
      GIT_TERMINAL_PROMPT: '0',
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

beforeAll(async () => {
  state.temp = mkdtempSync(join(tmpdir(), 'reviewos-action-mirror-'))
  state.store = join(state.temp, 'store')

  /*
   * Before the routes are imported, because the store root is read when the
   * module loads. A test that mirrors into a temporary directory and serves
   * from `storage/` is a test of two unrelated things.
   */
  process.env.REVIEWOS_ACTION_STORE = state.store
  state.origin = join(state.temp, 'origin', 'acme', 'setup.git')

  // The upstream: an ordinary repository holding an action.
  const work = join(state.temp, 'work')

  mkdirSync(join(state.temp, 'origin', 'acme'), { recursive: true })
  mkdirSync(work, { recursive: true })

  await git(state.temp, 'init', '--bare', '--initial-branch=main', state.origin)
  await git(work, 'init', '--initial-branch=main')

  writeFileSync(join(work, 'action.yml'), 'name: Setup\nruns:\n  using: composite\n  steps: []\n')
  await git(work, 'add', '-A')
  await git(work, 'commit', '-m', 'the action')
  await git(work, 'tag', 'v2')
  await git(work, 'push', state.origin, 'main', 'v2')

  state.sha = await git(work, 'rev-parse', 'HEAD')

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    serve = await route.serve({ port: 0, hostname: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${Number((serve as any)?.port ?? 0)}`

    available = true
  }
  catch (error) {
    console.warn(`[action-mirror] skipping the served half: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    serve?.stop?.()
  }
  catch { /* going away anyway */ }

  try {
    if (created.repositoryId)
      await db?.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    if (created.ownerId)
      await db?.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the files still go, below */ }

  if (state.temp)
    rmSync(state.temp, { recursive: true, force: true })
})

/** The upstream, as an origins map pointing at the repository on disk. */
function origins(): Record<string, string> {
  return { 'actions.example': `file://${join(state.temp, 'origin')}` }
}

describe('mirroring an action', () => {
  test('clones it the first time', async () => {
    const result = await mirrorAction('actions.example', 'acme/setup', { root: state.store, origins: origins() })

    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(isMirrored('actions.example', 'acme/setup', state.store)).toBe(true)
  }, 120_000)

  test('and updates it the second time rather than cloning again', async () => {
    const result = await mirrorAction('actions.example', 'acme/setup', { root: state.store, origins: origins() })

    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.reason).toBe('updated')
  }, 120_000)

  test('a tag pushed upstream arrives on the next sweep', async () => {
    const work = join(state.temp, 'work')

    await git(work, 'tag', 'v3')
    await git(work, 'push', state.origin, 'v3')

    await mirrorAction('actions.example', 'acme/setup', { root: state.store, origins: origins() })

    const mirror = String(actionPath('actions.example', 'acme/setup', state.store).path)
    const tags = await git(mirror, 'tag', '--list')

    expect(tags.split('\n').map(line => line.trim())).toContain('v3')
  }, 120_000)

  test('an upstream that does not exist fails with what git said, not a throw', async () => {
    const result = await mirrorAction('actions.example', 'acme/missing', { root: state.store, origins: origins() })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('acme/missing')
  }, 120_000)
})

describe('what gets mirrored', () => {
  test('is what the active workflows actually use', async () => {
    if (!available)
      return

    // A repository, a workflow, a version, and a step that uses an action.
    created.handle = unique('am')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Action Mirror', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: unique('repo'),
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/x.git`,
      })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        repository_id: created.repositoryId,
        path: '.github/workflows/ci.yml',
        name: 'CI',
        state: 'active',
      })
      .returning(['id']).executeTakeFirst()
    created.workflowId = Number(workflow?.id)

    const version: any = await db.insertInto('workflow_versions')
      .values({
        workflow_id: created.workflowId,
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/ci.yml',
        content_digest: unique('digest'),
        on_push: true,
      })
      .returning(['id']).executeTakeFirst()
    created.versionId = Number(version?.id)

    const job: any = await db.insertInto('workflow_version_jobs')
      .values({ workflow_version_id: created.versionId, job_id: 'build', name: 'Build', position: 0, runs_on: 'ubuntu-latest' })
      .returning(['id']).executeTakeFirst()
    created.jobId = Number(job?.id)

    for (const uses of ['acme/setup@v2', './local/thing', 'blocked.example/who/what@v1']) {
      await db.insertInto('workflow_version_steps').values({
        workflow_version_job_id: created.jobId,
        position: 0,
        uses,
      }).execute()
    }

    const policy = {
      allowedHosts: ['actions.example'],
      defaultHost: 'actions.example',
      requirePinnedSha: false,
      allowContainers: false,
    }

    const used = (await usedActions(policy)).filter(action => action.repository === 'acme/setup')

    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ host: 'actions.example', refs: ['v2'] })

    /*
     * The two that are not there matter as much as the one that is: a local
     * action has nothing to mirror, and one from a host the policy refuses is
     * code nobody is allowed to run - fetching it would be a network request
     * with no possible use.
     */
    const everything = await usedActions(policy)

    expect(everything.some(action => action.repository === 'who/what')).toBe(false)
  }, 120_000)
})

describe('serving the mirror back', () => {
  test('a runner can fetch through this instance, with the upstream gone', async () => {
    if (!available)
      return

    /*
     * The upstream is removed before this fetch, deliberately. A cache that
     * only works while the thing it caches is reachable is not a cache, and
     * this is the failure the box exists for: an instance that keeps building
     * when github.com does not.
     */
    rmSync(join(state.temp, 'origin'), { recursive: true, force: true })

    const { fetchAction } = await import('../../app/Actions/Runner/actionCache')
    const { parseActionRef } = await import('../../app/Actions/Runner/actionRef')

    const result = await fetchAction(parseActionRef('acme/setup@v2'), {
      root: join(state.temp, 'cache'),
      defaultHost: 'actions.example',
      // What an operator configures on every runner in a fleet: the host,
      // pointed at this instance.
      origins: { 'actions.example': `${baseUrl}/actions/actions.example` },
    })

    expect(result.ok).toBe(true)
    expect(result.sha).toBe(state.sha)
    expect(await Bun.file(join(String(result.path), 'action.yml')).text()).toContain('Setup')
  }, 120_000)

  /**
   * The process ceiling reaches this route too, which is the one that most
   * needs it: a fleet fetches actions here at the start of every job, so it is
   * the likeliest thing on the instance to be asked for a hundred
   * simultaneous `upload-pack`s. It was outside the ceiling until phase 16's
   * own review went looking for spawns the milestone had not named.
   */
  test('a saturated heavy class refuses with 503 rather than queueing', async () => {
    if (!available)
      return

    const { gitSemaphore } = await import('../../app/Actions/Git/semaphore')
    const semaphore = gitSemaphore('heavy')

    const held = await Promise.all(
      Array.from({ length: semaphore.limit }, () => semaphore.acquire()),
    )

    try {
      const answer = await fetch(
        `${baseUrl}/actions/actions.example/acme/setup.git/info/refs?service=git-upload-pack`,
      )

      expect(answer.status).toBe(503)
      expect(Number(answer.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    finally {
      for (const release of held)
        release?.()
    }
  }, 60_000)

  test('an action nobody mirrored is a 404 rather than an empty answer', async () => {
    if (!available)
      return

    // "This instance does not have that action" is a sentence a runner's git
    // turns into a readable error; an empty advertisement becomes "the
    // reference does not exist", which sends somebody looking at their
    // workflow instead of at the mirror.
    const answer = await fetch(
      `${baseUrl}/actions/actions.example/acme/never.git/info/refs?service=git-upload-pack`,
    )

    expect(answer.status).toBe(404)
  }, 60_000)

  test('and pushing to a mirror is not served at all', async () => {
    if (!available)
      return

    // A mirror that could be pushed to is a supply chain with a hole in it:
    // the whole value of mirroring an action here is that what this serves is
    // what upstream had.
    const answer = await fetch(`${baseUrl}/actions/actions.example/acme/setup.git/git-receive-pack`, {
      method: 'POST',
      body: '0000',
    })

    expect(answer.status).toBeGreaterThanOrEqual(400)
  }, 60_000)
})
