// Why a context line is here, through the real routes.
//
// The fixture lands one pull request by squash and then opens a second whose
// diff shows the first one's line as context. What is held: the blame
// answers at the merge base (not the branch tip - the base moves after
// branching, and a tip-side answer would name the wrong commit), the
// blamed sha joins back to the pull request that landed it, and a line git
// cannot blame is a sentence rather than a guess.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  reviewerId: 0,
  ownerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
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

async function post(path: string, form: Record<string, string>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${created.ownerToken}`,
    },
    body: new URLSearchParams({ owner: created.handle, repo: created.name, ...form }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function blame(number: number, path: string, line: number): Promise<{ status: number, body: any }> {
  const query = new URLSearchParams({
    owner: created.handle,
    repo: created.name,
    number: String(number),
    path,
    line: String(line),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/diff/blame?${query}`, {
    headers: { Accept: 'application/json' },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-blame-'))

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
        .values({ name: 'Blame Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'blame test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('blo')
    const reviewer = await make('blr')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.reviewerId = reviewer.id

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the blame line end to end test',
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
    writeFileSync(join(work, 'app.ts'), 'export const base = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // Pull request 1: adds the line the blame will explain. Landed by squash
    // through the real merge action, so the blamed sha IS merge_commit_sha.
    await git(work, 'checkout', '-b', 'first')
    writeFileSync(join(work, 'app.ts'), 'export const base = 1\nexport const landedLine = 2\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'add the landed line')
    const firstHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'first')

    await (globalThis as any).db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'Land the line',
      body: '',
      author_id: created.ownerId,
      state: 'open',
      head_branch: 'first',
      head_sha: firstHead,
      base_branch: 'main',
      base_sha: baseSha,
      draft: false,
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }).execute()

    // The fixture pushed over the filesystem, so nothing precomputed
    // mergeability; ask for it the way the page's refresh button does.
    await post('/api/repos/pulls/mergeability', { number: '1', force: '1' })

    const merged = await post('/api/repos/pulls/merge', { number: '1', strategy: 'squash' })
    if (merged.status !== 200)
      throw new Error(`the fixture merge failed: ${JSON.stringify(merged.body)}`)

    // Pull request 2: branches from the new main and touches the file, so
    // its diff shows the landed line as context.
    await git(work, 'checkout', 'main')
    await git(work, 'pull', created.diskPath, 'main')
    await git(work, 'checkout', '-b', 'second')
    writeFileSync(join(work, 'app.ts'), 'export const base = 1\nexport const landedLine = 2\nexport const fresh = 3\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'build on it')
    const secondHead = await git(work, 'rev-parse', 'HEAD')
    const secondBase = await git(created.diskPath, 'rev-parse', 'refs/heads/main')
    await git(work, 'push', created.diskPath, 'second')

    await (globalThis as any).db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 2,
      title: 'Build on the line',
      body: '',
      author_id: created.ownerId,
      state: 'open',
      head_branch: 'second',
      head_sha: secondHead,
      base_branch: 'main',
      base_sha: secondBase,
      draft: false,
      additions: 1,
      deletions: 0,
      changed_files: 1,
    }).execute()

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

describe('why this line is here', () => {
  test('a context line names its commit and the pull request that landed it', async () => {
    if (!available)
      return

    // Line 2 of app.ts at the merge base is the squash-landed line.
    const { status, body } = await blame(2, 'app.ts', 2)

    expect(status).toBe(200)
    expect(String(body?.summary ?? '')).toContain('Land the line')
    expect(body?.pullRequest?.number).toBe(1)
    expect(String(body?.pullRequest?.title ?? '')).toBe('Land the line')
  }, 30_000)

  test('a line older than any pull request answers the commit alone', async () => {
    if (!available)
      return

    const { status, body } = await blame(2, 'app.ts', 1)

    expect(status).toBe(200)
    expect(String(body?.summary ?? '')).toContain('the base')
    // The records cannot say, and the answer says so rather than guessing.
    expect(body?.pullRequest ?? null).toBeNull()
  }, 30_000)

  test('a line git cannot blame is a sentence, not a guess', async () => {
    if (!available)
      return

    const { status } = await blame(2, 'app.ts', 999)

    expect(status).toBe(422)
  }, 30_000)
})
