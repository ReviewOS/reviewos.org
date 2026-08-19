// Coverage, from a CI upload to a mark in the rendered diff.
//
// The round trip is the claim: lcov in over the API, keyed to the head
// commit, and the changed line no test executes carries the mark on the
// files tab - while a second upload replaces the first whole, because
// coverage is a statement about one run and merging two runs' opinions
// would produce a report no run ever made.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = {
  ownerId: 0,
  ownerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  headSha: '',
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

async function upload(lcov: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/coverage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${created.ownerToken}`,
    },
    body: new URLSearchParams({
      owner: created.handle,
      repo: created.name,
      sha: created.headSha,
      lcov,
    }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function filesTab(): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1?tab=files`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-coverage-'))

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

    created.handle = unique('cov')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Coverage Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(user?.id)
    const issued: any = await createToken(created.ownerId, 'coverage test')
    created.ownerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the coverage end to end test',
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
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\nexport const old = 2\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'app.ts'), 'export const keep = 1\nexport const changed = 2\nexport const untestedLine = 3\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the change')
    created.headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Coverage fixture',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.headSha,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 2,
        deletions: 1,
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

describe('coverage in the diff', () => {
  test('before any report, the diff carries no coverage claims at all', async () => {
    if (!available)
      return

    const html = await filesTab()

    // The markup, not the class name: the layout ships .is-uncovered styling
    // on every page.
    expect(/class="line[^"]*is-uncovered/.test(html)).toBe(false)
  }, 30_000)

  test('the report lands and the untested changed line carries the mark', async () => {
    if (!available)
      return

    // Line 3 is the added, untested line; line 2 changed and is covered.
    const { status, body } = await upload('SF:app.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n')

    expect(status).toBe(201)
    expect(body?.files).toBe(1)

    const html = await filesTab()
    const flagged = html.split('<tr').filter(row => /^ class="line[^"]*is-uncovered/.test(` ${row.trim()}`) || row.trimStart().startsWith('class="line') && row.includes('is-uncovered'))

    expect(flagged.length).toBe(1)
    expect(flagged[0]!.replace(/<[^>]+>/g, '')).toContain('untestedLine')
  }, 30_000)

  test('a second upload replaces the first whole', async () => {
    if (!available)
      return

    const { status } = await upload('SF:app.ts\nDA:1,1\nDA:2,1\nDA:3,4\nend_of_record\n')
    expect(status).toBe(201)

    const html = await filesTab()

    expect(/class="line[^"]*is-uncovered/.test(html)).toBe(false)
  }, 30_000)

  test('what does not read as lcov is refused', async () => {
    if (!available)
      return

    const { status } = await upload('not a report')

    expect(status).toBe(422)
  }, 30_000)
})
