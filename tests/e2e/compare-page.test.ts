// The compare page, on a history where the two modes genuinely differ.
//
// After the branch diverges, the base moves. The merge-base compare must not
// show the base's later commit; the direct compare must - and must say what
// it is showing. A fixture where the two answers agree could not tell the
// implementations apart, which is the roadmap's own lesson about tests.

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

async function page(refs: string): Promise<string> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/${created.handle}/${created.name}/compare/${refs}`,
    { headers: { Accept: 'text/html' } },
  )

  return await answer.text()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-compare-'))

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

    created.handle = unique('cmp')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Compare Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the compare page end to end test',
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
    writeFileSync(join(work, 'shared.ts'), 'export const shared = 0\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')

    // The branch's own work.
    await git(work, 'checkout', '-b', 'feature')
    writeFileSync(join(work, 'proposed.ts'), 'export const proposed = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the proposal')

    // The base moves AFTER the histories part: this commit is what makes the
    // two compare modes answer differently.
    await git(work, 'checkout', 'main')
    writeFileSync(join(work, 'meanwhile.ts'), 'export const meanwhile = 2\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'landed meanwhile')

    await git(work, 'push', created.diskPath, 'main')
    await git(work, 'push', created.diskPath, 'feature')

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

describe('the compare page', () => {
  test('the merge-base compare shows the proposal and nothing that landed meanwhile', async () => {
    if (!available)
      return

    const html = await page('main...feature')
    const text = html.replace(/<[^>]+>/g, '')

    expect(text).toContain('export const proposed')
    expect(text).not.toContain('export const meanwhile')
    expect(html).toContain('the diff a pull request')
    expect(html).toContain('the proposal')
  }, 30_000)

  test('the direct compare shows the difference between tips, and says so', async () => {
    if (!available)
      return

    const html = await page('main..feature')
    const text = html.replace(/<[^>]+>/g, '')

    // Tip to tip, the meanwhile commit is part of the difference.
    expect(text).toContain('export const meanwhile')
    expect(html).toContain('Tip to tip')
    // With the honest way out one click away.
    expect(html).toContain(`/compare/main...feature`)
  }, 30_000)

  test('one name compares against the default branch', async () => {
    if (!available)
      return

    const html = await page('feature')
    const text = html.replace(/<[^>]+>/g, '')

    expect(text).toContain('export const proposed')
    expect(text).not.toContain('export const meanwhile')
  }, 30_000)

  test('a ref that does not exist is a sentence, not a blank page', async () => {
    if (!available)
      return

    const html = await page('main...nowhere')

    expect(html).toContain('cannot be compared')
  }, 30_000)

  /*
   * And the sentence arrives under a status that agrees with it. `a...b` takes
   * two arbitrary strings, so a 200 on every pair offers a crawler the square
   * of the refs in the repository and calls all of it content.
   */
  test('and answers 404 rather than 200 while saying so', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/${created.handle}/${created.name}/compare/main...nowhere`,
      { headers: { Accept: 'text/html' } },
    )

    expect(answer.status).toBe(404)
  }, 30_000)

  /*
   * A half-written range is the page asking a question rather than failing to
   * answer one, so it keeps its 200 and its guidance. Only a range that names
   * two refs and cannot resolve them is a missing page.
   */
  test('but a half-written range is still a 200 with guidance', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/${created.handle}/${created.name}/compare/main...`,
      { headers: { Accept: 'text/html' } },
    )
    const html = await answer.text()

    expect(answer.status).toBe(200)
    expect(html).toContain('Nothing to compare')
  }, 30_000)
})
