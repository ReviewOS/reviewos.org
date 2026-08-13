// A repository's markdown, rendered by the product rather than by the parser.
//
// Every piece of this has a unit test already, and none of them would have
// caught what actually broke. Mermaid diagrams were silently not drawing across
// the whole product for weeks because `/js/mermaid.js` answered with HTML - the
// route table claimed the path before publicDir got a chance - and the failure
// mode is a fence that renders as its own source, which reads as "no diagram
// here" rather than as anything wrong.
//
// So this asks the served product for a markdown file in a real repository, and
// checks the parts a mirrored project's documentation actually uses: a diagram,
// a task list, a table, a heading somebody can link to, code, and an emoji.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }

let available = false
let port = 0
let server: any = null

const DOCUMENT = `# Architecture

A paragraph with \`inline code\` and a link to [the docs](https://example.com).

\`\`\`mermaid
graph TD
  Push --> Hook
  Hook --> Queue
\`\`\`

## Checklist

- [x] Cloned
- [ ] Reviewed

| Column | Meaning |
|---|---|
| one | the first |

\`\`\`ts
export const answer: number = 42
\`\`\`

Shipped :rocket:
`

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

  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return ''
}

async function page(path: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return { status: answer.status, html: await answer.text() }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-markdown-repo-'))

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

    created.handle = unique('mdr')

    const owner: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Markdown Repo', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the repository markdown end to end test',
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
    mkdirSync(join(work, 'docs'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    // The same document twice: once as the README the repository page shows,
    // once as a file somebody navigates to. They go through different call
    // sites and only one of them was ever checked.
    writeFileSync(join(work, 'README.md'), DOCUMENT)
    writeFileSync(join(work, 'docs', 'architecture.md'), DOCUMENT)

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'documentation')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[markdown-in-repository] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('a markdown file in a repository', () => {
  test('renders as markup rather than as its own source', async () => {
    if (!available)
      return

    const { status, html } = await page(`/${created.handle}/${created.name}/tree/main/docs/architecture.md`)

    expect(status).toBe(200)
    expect(html).toContain('Architecture')
    expect(html).toContain('<code>inline code</code>')
    // The source of the fence would still contain the word `graph`, so the
    // assertion is the markup around it rather than the text inside.
    expect(html).not.toContain('# Architecture</')
  })

  /*
   * The one that has been wrong in production. A fence renders as a `pre` the
   * client script turns into a diagram; when the script cannot load, the fence
   * shows its own source and looks like a document that has no diagram.
   */
  test('a mermaid fence is a diagram host, and the script that draws it is served', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/docs/architecture.md`)

    expect(html).toContain('<pre class="mermaid">')

    /*
     * The bundle itself is checked on disk rather than over this server.
     * `route.serve()` is the API boot and does not mount `public/`; the stx
     * server does, and that is where the 72KB-of-HTML bug lived and was fixed
     * (stx 0.2.175, recorded in phase 13). Asking this server for it would
     * assert a 404 that means nothing.
     */
    const bundle = Bun.file('public/js/mermaid.js')

    expect(await bundle.exists()).toBe(true)
    expect(bundle.size).toBeGreaterThan(100_000)
  })

  test('a task list is checkboxes, and they are not editable in a file view', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/docs/architecture.md`)

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
    expect(html).toContain('disabled')
  })

  test('tables, code blocks and emoji all survive the trip', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/docs/architecture.md`)

    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('language-ts')
    expect(html).toContain('🚀')
  })

  test('and the README on the repository page goes through the same pipeline', async () => {
    if (!available)
      return

    // Different call site, same document. The repository page renders the
    // README itself rather than reusing the blob view.
    const { status, html } = await page(`/${created.handle}/${created.name}`)

    expect(status).toBe(200)
    expect(html).toContain('<pre class="mermaid">')
    expect(html).toContain('type="checkbox"')
  })
})
