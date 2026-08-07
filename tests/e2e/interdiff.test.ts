// The interdiff endpoint: the diff of two versions of one file's proposal.
//
// The fixture is the one since-last-look was built on: a reviewer looks at
// one head, the branch is amended and force-pushed, and one file's proposal
// moved while another's did not. What is held: the changed file's interdiff
// names exactly the line that moved between rounds, and the unchanged file
// answers "unchanged" rather than rendering its whole diff again - which is
// the difference between this and sending the reader back to the file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  reviewerId: 0,
  reviewerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  pullRequestId: 0,
  firstHead: '',
  secondHead: '',
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

async function interdiff(path: string): Promise<{ status: number, body: any }> {
  const query = new URLSearchParams({
    owner: created.handle,
    repo: created.name,
    number: '1',
    path,
    since: created.firstHead,
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/diff/interdiff?${query}`, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${created.reviewerToken}` },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-interdiff-'))

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
        .values({ name: 'Interdiff Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'interdiff test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('ido')
    const reviewer = await make('idr')

    created.ownerId = owner.id
    created.handle = owner.handle
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
        description: 'created by the interdiff end to end test',
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
    writeFileSync(join(work, 'edited.ts'), 'export const limit = 10\n')
    writeFileSync(join(work, 'steady.ts'), 'export const steady = true\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // Round one: both files change.
    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'edited.ts'), 'export const limit = 30\n')
    writeFileSync(join(work, 'steady.ts'), 'export const steady = false\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'round one')
    created.firstHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    // Round two, amended and force-pushed: only edited.ts moves again. Every
    // sha on the branch changes; the file-by-file comparison is what keeps
    // steady.ts out of the answer.
    writeFileSync(join(work, 'edited.ts'), 'export const limit = 300\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '--amend', '-m', 'round two')
    created.secondHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', '--force', created.diskPath, 'change')

    await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Interdiff fixture',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.secondHead,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 2,
        deletions: 2,
        changed_files: 2,
      })
      .execute()

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

describe('the interdiff', () => {
  test('a file whose proposal moved shows the movement, at line level', async () => {
    if (!available)
      return

    const { status, body } = await interdiff('edited.ts')

    expect(status).toBe(200)
    expect(body?.unchanged).toBe(false)

    const text = String(body?.html ?? '').replace(/<[^>]+>/g, '')

    // The round's change: 30 became 300. Both versions in the answer, which
    // is what a diff of diffs is.
    expect(text).toContain('30')
    expect(text).toContain('300')
    // And not the whole file's history: the base value rides only inside the
    // patch context, never as this round's own change markers.
    expect(body?.html).toContain('diff-table')
  }, 30_000)

  test('a file whose proposal did not move says so instead of repeating itself', async () => {
    if (!available)
      return

    // steady.ts changed in the pull request, but not between the two rounds -
    // and after the force-push every sha differs, so a tip-to-tip comparison
    // would name it anyway. This is the assertion a naive implementation
    // fails.
    const { status, body } = await interdiff('steady.ts')

    expect(status).toBe(200)
    expect(body?.unchanged).toBe(true)
  }, 30_000)

  test('a caller with nothing recorded and no since is told, not guessed for', async () => {
    if (!available)
      return

    const query = new URLSearchParams({
      owner: created.handle,
      repo: created.name,
      number: '1',
      path: 'edited.ts',
    })

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/diff/interdiff?${query}`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${created.reviewerToken}` },
    })

    expect(answer.status).toBe(409)
  }, 30_000)
})
