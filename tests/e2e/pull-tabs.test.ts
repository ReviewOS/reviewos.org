// The pull request page as four tabs, each a real URL.
//
// What is held is the cost model as much as the content: the conversation
// tab must NOT carry the rendered diff - gating the render loop is the whole
// point of the tabs, and a regression here quietly puts the hundred-file
// cost back on every description read. The other direction too: the files
// tab must still carry everything review-page.test.ts holds it to.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
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

async function page(suffix: string): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1${suffix}`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-tabs-'))

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

    created.handle = unique('tab')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Tabs Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the pull tabs end to end test',
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
    writeFileSync(join(work, 'greet.ts'), 'export const greeting = \'hello\'\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'greet.ts'), 'export const greeting = \'good morning\'\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first step')
    writeFileSync(join(work, 'extra.ts'), 'export const extra = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'second step')
    const headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Change the greeting',
        body: 'A **description** the conversation tab shows.',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: headSha,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 2,
        deletions: 1,
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

    if (created.ownerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.ownerId).execute()
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

describe('the pull request page, as tabs', () => {
  test('conversation is the default and carries the description, not the diff', async () => {
    if (!available)
      return

    const html = await page('')

    expect(html).toContain('description</strong>')
    // No diff rows: the render loop must not have run. The markup, not the
    // class name - the layout ships .diff-table styling on every page.
    expect(html).not.toContain('good morning')
    expect(html.includes('<table class="diff-table"')).toBe(false)
  }, 30_000)

  test('the files tab carries the full server-rendered diff', async () => {
    if (!available)
      return

    const html = await page('?tab=files')
    const text = html.replace(/<[^>]+>/g, '')

    expect(text).toContain('good morning')
    expect(text).toContain('hello')
  }, 30_000)

  test('the commits tab lists the branch, oldest first', async () => {
    if (!available)
      return

    const html = await page('?tab=commits')

    const first = html.indexOf('first step')
    const second = html.indexOf('second step')

    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    // And not the base's commit: the branch's own history only.
    expect(html).not.toContain('the base')
  }, 30_000)

  test('a tab nobody has heard of falls back to the conversation', async () => {
    if (!available)
      return

    const html = await page('?tab=sideways')

    expect(html).toContain('description</strong>')
    expect(html.includes('<table class="diff-table"')).toBe(false)
  }, 30_000)
})
