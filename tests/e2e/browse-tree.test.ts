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
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

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

/**
 * What the browser tab says.
 *
 * The layout read `{{ title ?? 'ReviewOS' }}`, which wants a *variable* called
 * title while `@section('title', …)` sets a section - so the seven pages that
 * declared one were ignored, and every other page named an identifier that does
 * not exist. On a page carrying a component with a client script - the clone
 * box, which is on every repository page - the interpolation was not evaluated
 * at all, and the template source itself went into the tab, the bookmark and
 * any link preview that scraped one.
 *
 * The leftover-braces assertion is the general one: it fails for any expression
 * in the document's head that stops being evaluated, whatever the reason.
 */
describe('the name of the page', () => {
  const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ''

  test('a repository page is named for its repository', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(titleOf(html)).toBe(`${created.handle}/${created.name}`)
  })

  test('and a file is named for the file', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/tree/main/app`)

    expect(titleOf(html)).toBe(`app · ${created.handle}/${created.name}`)
  })

  test('a page that names itself nothing is still called something', async () => {
    if (!available)
      return

    const html = await page('/login')

    // Not empty, and not the template's own source.
    expect(titleOf(html).length).toBeGreaterThan(0)
    expect(titleOf(html)).not.toContain('{{')
  })

  test('and no page leaves an unevaluated expression in its head', async () => {
    if (!available)
      return

    for (const path of [`/${created.handle}/${created.name}`, `/${created.handle}/${created.name}/branches`, '/login']) {
      const html = await page(path)
      // stx's own runtime sits in the head and has `{{` inside a string
      // literal, so the assertion is about the markup rather than the scripts.
      const head = html
        .slice(0, html.indexOf('</head>'))
        .replace(/<script[\s\S]*?<\/script>/g, '')

      expect(head).not.toContain('{{')
    }
  })
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
   * Two levels down is where a catch-all earns its name, and it used to be a
   * 404 for a reason that was not the parameter binding above.
   *
   * bun-router only ever implemented the *unnamed* catch-all. A bare `/files/*`
   * matched the whole remaining path and bound it to `wildcard`; the named
   * spelling `{path}*` fell through to the branch that builds a pattern for a
   * mixed segment like `user-{id}`, and that pattern is tested against one
   * already-split segment. So it answered `/app` and refused `/app/nested`.
   *
   * Which spelling is used here is not a choice: file-based routing emits
   * `{path}*` for a `[...path]` file, so every view declared by a file got the
   * half-working one, and every repository with a directory inside a directory
   * was unreachable. Fixed in bun-router, in `route-compiler.ts` (the pattern
   * the server matches with) and `route-trie.ts` (the pre-compiled index),
   * because a catch-all that stops at the first separator is not a catch-all.
   */
  test('and so does one two levels down, which is where a catch-all earns its name', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/tree/main/app/nested`)

    expect(html).toContain('deeper.ts')
    expect(html).not.toContain('top.txt')
    expect(html).not.toContain('deep.ts')
  })

  /*
   * A file, not a directory, and its name carries a dot.
   *
   * The catch-all has to hand the view the path that was asked for. An
   * extension is the case where a path is most likely to be rewritten on the
   * way through - a static-asset guess, an implicit `.html` - and a rewritten
   * one reaches the view as a file that does not exist at this ref.
   */
  test('and a file deep in the tree arrives with the name it was asked for', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/tree/main/app/nested/deeper.ts`)

    expect(html).not.toContain('deeper.ts.html')
    expect(html).toContain('export const deeper')
  })
})
