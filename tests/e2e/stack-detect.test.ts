// A stack noticed on push, before any pull request exists.
//
// The pusher's terminal is the surface: the post-receive hook prints whatever
// the report endpoint answers, so the assertion here is on that answer. The
// endpoint is exercised the way the hook calls it - the wire that leads to
// the hook is git-http.test.ts's subject.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = {
  ownerId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  parentHead: '',
  stackedHead: '',
  plainHead: '',
  baseSha: '',
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

/** The report the post-receive hook makes, exactly as the hook makes it. */
async function report(updates: string): Promise<any> {
  const answer = await fetch(`http://127.0.0.1:${port}/internal/git/post-receive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Git-Hook-Secret': process.env.GIT_HOOK_SECRET ?? '',
    },
    body: JSON.stringify({ gitDir: created.diskPath, updates }),
  })

  return await answer.json().catch(() => null)
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-stackdetect-'))

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

    created.handle = unique('sdt')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Stack Detect', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(user?.id)

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the stack detect end to end test',
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
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // change1 has an open pull request; change2 is built on it and has none.
    await git(work, 'checkout', '-b', 'change1')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'layer one')
    created.parentHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change1')

    await git(work, 'checkout', '-b', 'change2')
    writeFileSync(join(work, 'c.txt'), 'c\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'layer two')
    created.stackedHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change2')

    // A branch straight off main: ordinary, not a stack.
    await git(work, 'checkout', 'main')
    await git(work, 'checkout', '-b', 'plain')
    writeFileSync(join(work, 'd.txt'), 'd\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'unstacked')
    created.plainHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'plain')

    await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Layer one',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change1',
        head_sha: created.parentHead,
        base_branch: 'main',
        base_sha: created.baseSha,
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
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

    if (created.ownerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    try {
      removeRepositoryOwnerDirectory(created.diskPath)
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

describe('a stack noticed on push', () => {
  test('a branch built on an open pull request is offered as a stacked one', async () => {
    if (!available)
      return

    const zero = '0'.repeat(40)
    const body = await report(`${zero} ${created.stackedHead} refs/heads/change2\n`)

    expect(body?.ok).toBe(true)

    const text = (body?.messages ?? []).join('\n')
    expect(text).toContain(`branch 'change2' looks stacked on 'change1'`)
    expect(text).toContain(`/${created.handle}/${created.name}/compare/change1...change2`)
  }, 30_000)

  test('a branch straight off the default branch is not nagged about', async () => {
    if (!available)
      return

    const zero = '0'.repeat(40)
    const body = await report(`${zero} ${created.plainHead} refs/heads/plain\n`)

    expect(body?.ok).toBe(true)
    expect((body?.messages ?? []).join('\n')).toBe('')
  }, 30_000)

  test('a branch that already has a pull request has already chosen', async () => {
    if (!available)
      return

    const body = await report(`${created.baseSha} ${created.parentHead} refs/heads/change1\n`)

    expect(body?.ok).toBe(true)
    expect((body?.messages ?? []).join('\n')).toBe('')
  }, 30_000)
})
