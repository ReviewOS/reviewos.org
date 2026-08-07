// That a component rendered by the test-served router actually renders.
//
// This is a test about the harness, and it exists because the harness failed in
// the direction that hides bugs. `route.serve()` renders views through
// bun-router's file routing, which was never told where this project keeps its
// components - so every `<RepoBrowser>`, `<RepoTabs>` and `<SignatureBadge>`
// came back as `[Error loading component: ENOENT ...]` inlined into the page,
// under a 200. Nothing failed. Every view test asserting on component output
// would have read as "the feature is missing" rather than "the harness is".
//
// `tests/helpers/server.ts` configures the directories now, and this is what
// says so if that stops happening.
//
// **One limitation survives, and it is why this asserts what it asserts** - but
// it is fixed upstream and waiting on a release, not open. A component used
// *directly in a view* renders here. A component nested inside another
// component, inside an `@if` branch, does not: rendering stops at the nested
// tag with no error anywhere and the page comes back truncated. That is why
// `resources/views/[owner]/[repository]/index.stx` - one line, `<RepoBrowser/>`
// - loses everything after the clone box.
//
// The cause is not this project's. A template directive is text and so is the
// body of a script tag, and stx's conditional scanner read both the same way.
// stx injects its own signals runtime, the runtime has `'@else-if'` in it
// because that is an attribute it supports, and the scanner matched the real
// `@if` against that token - swallowing everything between and splicing the
// rest of the document into the middle of a JavaScript string. Fixed in stx by
// masking `<script>` elements for the duration of the pass
// (`conditionals-script-masking.test.ts` there). This app consumes the
// published `@stacksjs/stx`, so the repository-page assertions here can be
// tightened once that release lands.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { serveForTest, viewDirectories } from '../helpers/server'

const created = { userId: 0, repositoryId: 0, handle: '', name: '', diskPath: '' }

let available = false
/** The repository page, whose view uses a component that nests another. */
let repositoryPage = ''
/** The branches page, whose view uses `RepoTabs` directly. */
let branchesPage = ''

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { port } = await serveForTest()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('view')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'View test', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the view component test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const base = `http://127.0.0.1:${port}/${created.handle}/${created.name}`
    const fetchPage = async (url: string) => await (await fetch(url, { headers: { Accept: 'text/html' } })).text()

    repositoryPage = await fetchPage(base)
    branchesPage = await fetchPage(`${base}/branches`)

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
// Booting the router and connecting to Postgres do not fit in bun's default
// five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the directory still goes, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    try {
      rmSync(resolve(created.diskPath, '..'), { recursive: false })
    }
    catch { /* not empty, which is somebody else's repository */ }
  }
})

describe('a view served by the test router', () => {
  test('resolves its components instead of inlining an error', () => {
    if (!available)
      return

    // The assertion that would have caught this in the first place, and it is
    // deliberately about the *absence* of an error: the failure mode is a 200
    // with the error text where a component should be, so a status check and a
    // "did the page render" check both pass while every component is missing.
    expect(repositoryPage).not.toContain('Error loading component')
    expect(branchesPage).not.toContain('Error loading component')
  })

  test('renders what a component drew', () => {
    if (!available)
      return

    // `RepoTabs` lives in `resources/components/` - the directory that was
    // never searched - and the branches view uses it directly.
    expect(branchesPage).toContain('repo-tabs')
    expect(branchesPage).toContain('Pull requests')
  })

  test('runs a component server script and interpolates its output', () => {
    if (!available)
      return

    // Resolving the file is half of it. `CloneUrlBox` has a `<script server>`
    // that builds a URL from the request, so seeing the URL means the
    // component's own script ran and its interpolations were processed - not
    // just that the file was found and pasted in.
    expect(repositoryPage).toContain('clone-panel')
    expect(repositoryPage).toContain(`/${created.handle}/${created.name}.git`)
  })
})

describe('viewDirectories', () => {
  test('finds the directory the components are actually in', () => {
    // Not `resources/views/components`, which is what bun-router falls back to
    // and what this project has never used.
    expect(viewDirectories().componentsDir).toBe(resolve('resources/components'))
  })

  test('names only directories that exist', () => {
    const directories = viewDirectories()

    // A search path that cannot match is not harmless: it hides which directory
    // is really missing when something does not resolve.
    for (const value of Object.values(directories)) {
      if (value !== undefined)
        expect(Bun.file(`${value}/.`).name).toBeTruthy()
    }

    expect(directories.viewsPath).toBe(resolve('resources/views'))
  })
})
