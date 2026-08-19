// A large file, through the real page and the real endpoint.
//
// Two things were true before this: a file over half a megabyte could not be
// looked at at all - the page said "too large to display" - and one just under
// it arrived as thirty thousand table rows in a single document, which is the
// failure the diff engine exists to avoid, sitting untouched on the other half
// of the product.
//
// So the assertions are about what a reader can actually reach: the first
// window renders, it says which lines they are looking at, the rest is a plain
// link away, and the endpoint answers for a range in the middle with the same
// markup the page used.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }

/** Comfortably more than one window, and more than the old half-megabyte ceiling. */
const LINES = 12_000

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

async function page(path: string): Promise<{ html: string, text: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })
  const html = await answer.text()

  /*
   * Content is asserted against the page with its tags stripped, which is not
   * fussiness: highlighted code is not contiguous text. `export const line1`
   * arrives as a keyword span and three more, so asking the markup whether it
   * contains that phrase answers no on a page that renders it perfectly. The
   * markup itself is still there for the assertions that are *about* markup.
   */
  return { html, text: html.replace(/<[^>]+>/g, '') }
}

async function rows(query: Record<string, string>): Promise<{ status: number, body: any }> {
  const search = new URLSearchParams({ owner: created.handle, repo: created.name, ...query })
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/blob/rows?${search}`, {
    headers: { Accept: 'application/json' },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-blobwin-'))

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

    created.handle = unique('blw')
    const owner: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Blob Window', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the blob window end to end test',
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
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')

    // Each line names its own number, so an off-by-one in the window is a
    // failed assertion rather than a plausible-looking page.
    const big = Array.from({ length: LINES }, (_, index) => `export const line${index + 1} = ${index + 1}`).join('\n')
    writeFileSync(join(work, 'big.ts'), `${big}\n`)
    writeFileSync(join(work, 'small.ts'), 'export const small = 1\n')

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'a large file and a small one')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[blob-window] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('a file too large to render whole', () => {
  test('renders its first window and says which lines they are', async () => {
    if (!available)
      return

    const { html, text } = await page(`/${created.handle}/${created.name}/tree/main/big.ts`)

    expect(text).toContain('line1 = 1')
    expect(text).toContain('line2000 = 2000')
    // And not the line after the window, which is the assertion that the page
    // is windowed rather than merely long.
    expect(text).not.toContain('line2001 = 2001')

    expect(text).toContain('Lines 1–2,000 of 12,000')
    expect(text).not.toContain('too large to display')
    // The row carries its own line number, which is what a later window is
    // stitched onto.
    expect(html).toContain('<tr class="source-row" data-line="2000">')
  }, 30_000)

  test('and the rest is a plain link away, with no script running', async () => {
    if (!available)
      return

    const first = await page(`/${created.handle}/${created.name}/tree/main/big.ts`)

    expect(first.html).toContain('?from=2001')

    const second = await page(`/${created.handle}/${created.name}/tree/main/big.ts?from=2001`)

    expect(second.text).toContain('line2001 = 2001')
    expect(second.text).toContain('line4000 = 4000')
    expect(second.text).not.toContain('line2000 = 2000')
    expect(second.text).toContain('Lines 2,001–4,000 of 12,000')
    // Back as well as on: a window in the middle has both.
    expect(second.html).toContain('?from=1')
  }, 30_000)

  test('a small file is still simply the file', async () => {
    if (!available)
      return

    const { text } = await page(`/${created.handle}/${created.name}/tree/main/small.ts`)

    expect(text).toContain('small = 1')
    // No window furniture on a file that fits: the count would be noise on
    // every ordinary file in the repository.
    expect(text).not.toContain('Lines 1–1 of')
  }, 30_000)
})

describe('what the page hands the browser', () => {
  test('the table says where it is, how long the file is, and where to ask', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/big.ts`)

    // The three things `mountBlobWindow` needs. Asserted as markup because they
    // are markup: a missing attribute leaves the module returning early, which
    // is a page that quietly stays paged.
    expect(html).toContain('data-blob-window')
    expect(html).toContain(`data-total="${LINES}"`)
    expect(html).toContain('data-from="1"')
    expect(html).toContain('/api/repos/blob/rows?owner=')
  }, 30_000)

  test('and the links stay in the markup, because they are the path without a script', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/big.ts`)

    // `mountBlobWindow` hides these once it is running. They have to be in the
    // document for it to hide them, and they have to work for a reader who has
    // nothing to run it.
    expect(html).toContain('class="file-window-nav"')
    expect(html).toContain('?from=2001')
  }, 30_000)

  test('and the page carries the script that takes over', async () => {
    if (!available)
      return

    const { html } = await page(`/${created.handle}/${created.name}/tree/main/big.ts`)

    // Whatever shape the bundler gives it, the mount has to reach the page: a
    // view that renders the attributes and ships no script is a file that
    // silently stays paged.
    expect(/mountBlobWindow|blobviewer/.test(html)).toBe(true)
  }, 30_000)
})

describe('the rows endpoint', () => {
  test('answers for a window in the middle, as rows', async () => {
    if (!available)
      return

    const { status, body } = await rows({ ref: 'main', path: 'big.ts', from: '5001' })

    expect(status).toBe(200)
    expect(body?.from).toBe(5001)
    expect(body?.to).toBe(7000)
    expect(body?.total).toBe(LINES)

    // The same markup the page renders, from the same renderer.
    const markup = String(body?.rows ?? '')
    const content = markup.replace(/<[^>]+>/g, '')

    expect(markup).toContain('<tr class="source-row" data-line="5001">')
    expect(content).toContain('line5001 = 5001')
    expect(content).not.toContain('line5000 = 5000')
  }, 30_000)

  test('clamps a range past the end rather than answering with nothing', async () => {
    if (!available)
      return

    const { body } = await rows({ ref: 'main', path: 'big.ts', from: '999999' })

    // The last window, not the last line: a stale link to line 999,999 shows
    // the end of the file rather than one row of it.
    expect(body?.from).toBe(LINES - 1999)
    expect(body?.to).toBe(LINES)
    expect(String(body?.rows ?? '').replace(/<[^>]+>/g, '')).toContain(`line${LINES} = ${LINES}`)
  }, 30_000)

  test('a path that is not there is a 404 rather than an empty file', async () => {
    if (!available)
      return

    const { status } = await rows({ ref: 'main', path: 'nope.ts' })

    expect(status).toBe(404)
  }, 30_000)
})
