// A stack landing in order, with the layers above rebased as the layers
// below merge - the restack, and the merge queue that falls out of it.
//
// The fixture is the smallest real stack: change1 onto main, change2 onto
// change1. The bottom is squash-merged, which is the strategy that makes
// restacking matter: the parent's original commits never reach main, so an
// unrestacked child would show the parent's work in its own diff forever.
// What is held: the child's branch is rebased onto the merge result, its own
// commit survives, the parent's file arrives via main rather than via the
// child, and - with both layers armed - the approval cascade lands the whole
// stack in order without anybody pressing merge.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  reviewerId: 0,
  ownerToken: '',
  reviewerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  parentId: 0,
  childId: 0,
  childHead: '',
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

async function post(path: string, token: string, form: Record<string, string>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body: new URLSearchParams({ owner: created.handle, repo: created.name, ...form }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function row(id: number): Promise<any> {
  return await (globalThis as any).db
    .selectFrom('pull_requests')
    .select(['state', 'base_branch', 'stack_parent_id', 'head_sha', 'merged_by_id'])
    .where('id', '=', id)
    .executeTakeFirst()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-restack-'))

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
      const userRow: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Restack Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(userRow?.id)
      const issued: any = await createToken(id, 'restack test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('rso')
    const reviewer = await make('rsr')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.reviewerId = reviewer.id
    created.reviewerToken = reviewer.token

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the restack end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolvedPath.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    await (globalThis as any).db
      .insertInto('protected_branches')
      .values({ repository_id: created.repositoryId, pattern: 'main', required_approvals: 1 })
      .execute()

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change1')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'layer one')
    const parentHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change1')

    await git(work, 'checkout', '-b', 'change2')
    writeFileSync(join(work, 'c.txt'), 'c\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'layer two')
    created.childHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change2')

    const parent: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Layer one',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change1',
        head_sha: parentHead,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.parentId = Number(parent?.id)

    const child: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 2,
        title: 'Layer two',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change2',
        head_sha: created.childHead,
        base_branch: 'change1',
        base_sha: parentHead,
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        stack_parent_id: created.parentId,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.childId = Number(child?.id)

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

    for (const id of [created.ownerId, created.reviewerId]) {
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

describe('a stack landing in order', () => {
  test('an armed child waits behind its unmerged parent', async () => {
    if (!available)
      return

    const arm = await post('/api/repos/pulls/auto-merge', created.ownerToken, { number: '2', strategy: 'squash' })
    expect(arm.status).toBe(200)
    expect(arm.body?.merged).toBe(false)

    // Even fully approved, the parent is the blocker.
    const review = await post('/api/repos/pulls/reviews', created.reviewerToken, { number: '2', state: 'approved', body: '' })
    expect(review.status).toBe(201)

    expect(String((await row(created.childId))?.state)).toBe('open')
  }, 30_000)

  test('the parent landing rebases the child and the cascade merges it', async () => {
    if (!available)
      return

    // Arm the parent; its approval is the only thing missing.
    const arm = await post('/api/repos/pulls/auto-merge', created.ownerToken, { number: '1', strategy: 'squash' })
    expect(arm.body?.merged).toBe(false)

    const review = await post('/api/repos/pulls/reviews', created.reviewerToken, { number: '1', state: 'approved', body: '' })
    expect(review.status).toBe(201)

    // The parent merged on the approval...
    const parent = await row(created.parentId)
    expect(String(parent?.state)).toBe('merged')

    // ...which restacked the child onto main and let its own arm fire.
    const child = await row(created.childId)
    expect(String(child?.state)).toBe('merged')
    expect(String(child?.base_branch)).toBe('main')

    // The child's branch was genuinely rebased before it merged: its head
    // moved off the fixture sha, and main's tree carries both layers' files
    // with the child's own commit in history exactly once.
    expect(String(child?.head_sha)).not.toBe(created.childHead)

    const files = (await git(created.diskPath, 'ls-tree', '--name-only', 'refs/heads/main')).split('\n')
    expect(files).toContain('b.txt')
    expect(files).toContain('c.txt')

    const subjects = await git(created.diskPath, 'log', '--format=%s', 'refs/heads/main')
    expect(subjects.split('\n').filter(line => line.includes('Layer two')).length).toBe(1)
  }, 60_000)
})
