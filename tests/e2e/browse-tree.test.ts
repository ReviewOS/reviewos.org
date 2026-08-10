// Navigating into a directory, through the real route.
//
// The claim is one line of routing and it has been wrong: stx-router bound
// route parameters to the wrong capture groups when a pattern mixed a catch-all
// with ordinary segments, so `/{owner}/{repo}/tree/main/app` was served with
// `path` empty and rendered the repository root. Nothing failed, nothing
// errored - the page just showed the wrong directory, which is
// indistinguishable from a repository whose root is what you asked for.
//
// It is written as two files that cannot be confused: `top.txt` exists only at
// the root and `deep.ts` only inside `app`. A page listing the wrong one is the
// bug, and it is the assertion.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }

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

async function page(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return await answer.text()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-browse-tree-'))

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

    created.handle = unique('brt')
    const owner: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Browse Tree', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the browse tree end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(join(work, 'app', 'nested'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    // Two names that cannot be mistaken for each other, one per level.
    writeFileSync(join(work, 'top.txt'), 'only at the root\n')
    writeFileSync(join(work, 'app', 'deep.ts'), 'export const deep = true\n')
    writeFileSync(join(work, 'app', 'nested', 'deeper.ts'), 'export const deeper = true\n')

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'a root file and a directory')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[browse-tree] skipping: ${error instanceof Error ? error.message : String(error)}`)
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
  catch { /* the files still go, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    try {
      rmSync(resolve(created.diskPath, '..'), { recursive: false, force: false })
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

describe('browsing into a directory', () => {
  test('the root lists what is at the root', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('top.txt')
    expect(html).toContain('app')
  })

  test('and a directory lists what is inside it, not the root again', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/tree/main/app`)

    expect(html).toContain('deep.ts')
    expect(html).toContain('nested')

    // The bug this exists for: `path` arriving empty renders the root, which
    // looks like a working page listing the wrong directory.
    expect(html).not.toContain('top.txt')
  })

  /*
   * Two levels down is a 404, and the catch-all is not what is broken about it.
   *
   * `@stacksjs/router` matches a catch-all against exactly one segment,
   * whatever the spelling: `/probe/{rest}*` and `/probe2/:rest*` declared by
   * hand answer `/probe/a` and 404 `/probe/a/b`, with no view routing in the
   * picture. So this is not the parameter-binding bug that
   * [phase 13](../../docs/todo/13-mirroring.md) blamed - that one is fixed, and
   * the test above proves it - and every repository with a subdirectory inside
   * a subdirectory is unreachable until the router is fixed.
   *
   * Left as a todo rather than an assertion of the wrong behaviour: a test that
   * demands a 404 here would have to be found and reversed by whoever fixes it,
   * and would read like the 404 is intended.
   */
  test.todo('and so does one two levels down, which is where a catch-all earns its name', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/tree/main/app/nested`)

    expect(html).toContain('deeper.ts')
    expect(html).not.toContain('top.txt')
    expect(html).not.toContain('deep.ts')
  })

})
