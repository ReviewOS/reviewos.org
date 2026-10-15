// A runner off the instance's host checks out a private repository with the
// credential its job was claimed with.
//
// It had nothing to do it with: the remote runner clones over HTTP, a private
// repository answers 404 to anybody it does not know, and the job's own
// credential was not accepted there - so every job of every private repository
// failed at "the checkout failed (git exit 128)" on any runner but the
// instance's own. Found moving stacksjs/hq.training's CI onto its own box.
//
// What is pinned: a running job reads its own repository and nothing else,
// only while its lease is live, and never pushes.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const RUNNER_TOKEN = `runner-${crypto.randomUUID()}`

const created = { ownerId: 0, handle: '', temp: '', runnerId: 0, mine: { id: 0, name: '', path: '' }, other: { id: 0, name: '', path: '' } }
let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<{ code: number, stderr: string, stdout: string }> {
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
      // Nobody's own git config: a credential helper (osxkeychain on a Mac)
      // would remember the first job's credential for this host and port and
      // hand it to the "anonymous" clone below.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })

  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stderr, stdout }
}

/** A private repository with one commit and a workflow, on disk where the instance serves it. */
async function privateRepository(): Promise<{ id: number, name: string, path: string }> {
  const { repositoryPath } = await import('../../app/Actions/Git/storage')
  const { initBare } = await import('../../app/Actions/Git/git')

  const name = unique('repo')
  const path = repositoryPath(created.handle, name).path!
  const row: any = await db.insertInto('repositories').values({
    owner_type: 'user',
    owner_id: created.ownerId,
    name,
    visibility: 'private',
    default_branch: 'main',
    disk_path: path,
  }).returning(['id']).executeTakeFirst()

  mkdirSync(resolve(path, '..'), { recursive: true })
  await initBare(path, 'main')

  const work = join(created.temp, name)
  mkdirSync(work, { recursive: true })
  await git(work, 'init', '--initial-branch=main')
  writeFileSync(join(work, 'README.md'), 'private\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', 'first')
  await git(work, 'push', path, 'main')

  return { id: Number(row.id), name, path }
}

/** Start a run on `repositoryId` and claim its job, keeping the credential it was handed. */
async function claim(repositoryId: number): Promise<string> {
  await dispatchPush({
    repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: `${Math.random().toString(16).slice(2)}`.padEnd(40, '0'),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${RUNNER_TOKEN}` },
    body: '{}',
  })

  const body: any = await answer.json()
  return String(body?.job?.token ?? '')
}

function urlOf(repository: { name: string }, secret: string): string {
  return `http://x-job:${encodeURIComponent(secret)}@127.0.0.1:${port}/${created.handle}/${repository.name}.git`
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-jobclone-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_jobs').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('jcl')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Job Clone', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.mine = await privateRepository()
    created.other = await privateRepository()

    // A runner for this one repository, the way a project's own box is registered.
    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.mine.id,
      token_hash: hashToken(RUNNER_TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()
    created.runnerId = Number(runner.id)

    await syncWorkflowFile({
      repositoryId: created.mine.id,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: build\n',
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[runner-job-clone] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    for (const id of [created.mine.id, created.other.id].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  for (const path of [created.mine.path, created.other.path].filter(Boolean)) {
    removeRepositoryDirectory(path)
    try {
      removeRepositoryOwnerDirectory(path)
    }
    catch { /* shared with the other one */ }
  }

  rmSync(created.temp, { recursive: true, force: true })
})

describe('a running job, reading over HTTP', () => {
  test('clones its own private repository with the credential it was claimed with', async () => {
    if (!available)
      return

    const secret = await claim(created.mine.id)
    expect(secret).not.toBe('')

    const cloned = await git(created.temp, 'clone', urlOf(created.mine, secret), join(created.temp, 'cloned'))
    expect(cloned.stderr).not.toContain('fatal')
    expect(cloned.code).toBe(0)
  })

  test('the runner\'s own checkout does it, through the /git mount a deployed instance forwards', async () => {
    if (!available)
      return

    const secret = await claim(created.mine.id)
    const { checkoutCode } = await import('../../app/Actions/Runner/checkout')
    const sha = (await git(created.mine.path, 'rev-parse', 'refs/heads/main')).stdout.trim()
    const workspace = join(created.temp, 'workspace', 'job')
    mkdirSync(workspace, { recursive: true })

    let said = ''
    const outcome = await checkoutCode({
      reposRoot: join(created.temp, 'no-repositories-here'),
      fullName: `${created.handle}/${created.mine.name}`,
      sha,
      workspace,
      baseUrl: `http://127.0.0.1:${port}`,
      cloneToken: secret,
      onOutput: async (text) => { said += text },
      run: async ({ command, cwd, environment }) => {
        const child = Bun.spawn(['/bin/sh', '-c', command], {
          cwd,
          env: { ...process.env, ...environment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        said += await new Response(child.stderr).text()
        const exitCode = await child.exited
        return { ok: exitCode === 0, exitCode }
      },
    })

    expect(outcome.ok, said).toBe(true)
    expect((await git(workspace, 'rev-parse', 'HEAD')).stdout.trim()).toBe(sha)
    // Cloned from the mounted URL, the one a deployed instance forwards to
    // the API - not the bare root URL only the API process itself answers.
    const origin = (await git(workspace, 'config', '--get', 'remote.origin.url')).stdout.trim()
    expect(origin).toBe(`http://127.0.0.1:${port}/git/${created.handle}/${created.mine.name}.git`)
  })

  test('and nobody without one does', async () => {
    if (!available)
      return

    const anonymous = await git(created.temp, 'clone', `http://127.0.0.1:${port}/${created.handle}/${created.mine.name}.git`, join(created.temp, 'anonymous'))
    expect(anonymous.code).not.toBe(0)

    const guessed = await git(created.temp, 'clone', urlOf(created.mine, 'not-a-job'), join(created.temp, 'guessed'))
    expect(guessed.code).not.toBe(0)
  })

  test('reaches no other private repository', async () => {
    if (!available)
      return

    const secret = await claim(created.mine.id)
    const elsewhere = await git(created.temp, 'clone', urlOf(created.other, secret), join(created.temp, 'elsewhere'))
    expect(elsewhere.code).not.toBe(0)
  })

  test('never pushes', async () => {
    if (!available)
      return

    const secret = await claim(created.mine.id)
    const work = join(created.temp, 'pusher')
    await git(created.temp, 'clone', urlOf(created.mine, secret), work)
    writeFileSync(join(work, 'NEW.md'), 'pushed by a job\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'from a job')

    const pushed = await git(work, 'push', 'origin', 'main')
    expect(pushed.code).not.toBe(0)
  })

  test('and stops reading when its lease is gone', async () => {
    if (!available)
      return

    const secret = await claim(created.mine.id)
    await db.updateTable('workflow_jobs')
      .set({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('job_token_hash', '=', hashToken(secret))
      .execute()

    const late = await git(created.temp, 'clone', urlOf(created.mine, secret), join(created.temp, 'late'))
    expect(late.code).not.toBe(0)
  })
})
