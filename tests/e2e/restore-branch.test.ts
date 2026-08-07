// Restoring a merged pull request's head branch, through the real routes.
//
// The rule is small and the write is one ref, which is exactly the kind of
// endpoint that ships wrong quietly: the wrong ability, an unguarded create,
// or a restore offered on a pull request that never merged. So this asks the
// route, with real credentials, and asks git where the ref ended up.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  strangerId: 0,
  ownerToken: '',
  strangerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  headSha: '',
  repositoryId: 0,
}

let available = false
let port = 0
let server: any = null

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

/** The write a browser or client makes: a bearer, no cookie, so no CSRF. */
async function restore(number: number, token: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/restore-branch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body: new URLSearchParams({ owner: created.handle, repo: created.name, number: String(number) }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function openPullRequest(options: { number: number, state: string, headBranch: string, headSha: string }): Promise<void> {
  await (globalThis as any).db.insertInto('pull_requests').values({
    repository_id: created.repositoryId,
    number: options.number,
    title: `Restore fixture ${options.number}`,
    body: '',
    author_id: created.ownerId,
    state: options.state,
    head_branch: options.headBranch,
    head_sha: options.headSha,
    base_branch: 'main',
    base_sha: options.headSha,
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    ...(options.state === 'merged' ? { merged_at: new Date().toISOString(), merged_by_id: created.ownerId } : {}),
  }).execute()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-restore-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, handle: string, token: string }> => {
      const handle = unique(prefix)
      const row: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Restore Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'restore branch test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('rbo')
    const stranger = await make('rbs')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the restore branch end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolvedPath.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'second')
    created.headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    // The merge happened and delete-on-merge took the branch: the state this
    // endpoint exists for, arranged directly.
    await git(created.diskPath, 'update-ref', '-d', 'refs/heads/change')

    await openPullRequest({ number: 1, state: 'merged', headBranch: 'change', headSha: created.headSha })
    await openPullRequest({ number: 2, state: 'open', headBranch: 'still-open', headSha: created.headSha })

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    for (const id of [created.ownerId, created.strangerId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    try {
      rmdirSync(resolve(created.diskPath, '..'))
    }
    catch { /* somebody else's repository lives there too */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('restoring a deleted head branch', () => {
  test('somebody who may not push is refused before anything is written', async () => {
    if (!available)
      return

    const { status } = await restore(1, created.strangerToken)

    expect(status).toBeGreaterThanOrEqual(401)
    expect(status).toBeLessThanOrEqual(404)

    const check = await git(created.diskPath, 'for-each-ref', 'refs/heads/change')
    expect(check).toBe('')
  }, 30_000)

  test('an open pull request has nothing to restore', async () => {
    if (!available)
      return

    const { status, body } = await restore(2, created.ownerToken)

    expect(status).toBe(409)
    expect(String(body?.error ?? '')).toContain('merged')
  }, 30_000)

  test('the branch comes back at the sha the pull request records', async () => {
    if (!available)
      return

    const { status, body } = await restore(1, created.ownerToken)

    expect(status).toBe(200)
    expect(body?.restored).toBe(true)

    const sha = await git(created.diskPath, 'rev-parse', 'refs/heads/change')
    expect(sha).toBe(created.headSha)
  }, 30_000)

  test('restoring again refuses: the branch is back, and is not overwritten', async () => {
    if (!available)
      return

    const { status, body } = await restore(1, created.ownerToken)

    expect(status).toBe(409)
    expect(String(body?.error ?? '')).toContain('already exists')
  }, 30_000)
})
