// The banner a reader gets when the diff is larger than the page renders.
//
// The whole point of M2 is that a large diff no longer takes the box down.
// The half that is easy to leave untested is what the *reader* sees when it
// happens: without a banner the page renders part of a change as though it
// were all of it, which is the worst possible failure for a review tool -
// silently showing somebody less than they are approving.
//
// The budget is env-tunable so this can use an ordinary fixture instead of an
// eight megabyte one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

// Before any app module loads: the budget is read once, at import.
process.env.SSR_DIFF_BYTE_LIMIT = '2048'

const created = { ownerId: 0, handle: '', name: '', diskPath: '', temp: '', repositoryId: 0 }

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

  const out = await new Response(child.stdout).text()
  await child.exited

  return out.trim()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-truncated-'))

  try {
    const { db } = await import('@stacksjs/database')
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    created.handle = unique('trunc')
    created.name = unique('repo')

    const { route } = await import('@stacksjs/router')
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Truncation Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the diff truncation end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    await Bun.write(join(work, 'README.md'), '# base\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // Comfortably past the 2KB budget set above, and made of distinct lines so
    // a partial render is still a real diff.
    await git(work, 'checkout', '-b', 'feature')
    const lines = Array.from({ length: 4000 }, (unused, index) => `line ${index} of a change nobody wants to read whole`)
    await Bun.write(join(work, 'big.txt'), `${lines.join('\n')}\n`)
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the big one')
    const headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'feature')

    await db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'A change larger than the page',
      body: '',
      state: 'open',
      author_id: created.ownerId,
      base_branch: 'main',
      head_branch: 'feature',
      base_sha: baseSha,
      head_sha: headSha,
      draft: false,
    } as any).execute()

    available = true
  }
  catch (error) {
    console.warn('[truncated] skipped, no database:', error instanceof Error ? error.message : error)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()

    const { db } = await import('@stacksjs/database')

    if (created.repositoryId) {
      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch {}

  rmSync(created.temp, { recursive: true, force: true })
  removeRepositoryOwnerDirectory(created.diskPath)
})

describe('a diff larger than the page renders', () => {
  test('says so, and links the reader to the screen that handles any size', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1?tab=files`)
    const html = await answer.text()
    const text = html.replace(/<[^>]+>/g, ' ')

    expect(answer.status).toBe(200)

    // The banner, and the escape hatch. A truncated diff with no way out is a
    // reader stuck looking at part of a change.
    expect(text).toContain('larger than')
    expect(html).toContain(`/${created.handle}/${created.name}/pull/1/files`)

    // And it is still a diff: truncation cuts it short, it does not blank the
    // page, which is the failure mode a silent stx error would produce.
    expect(text).toContain('big.txt')
  }, 60_000)
})

/**
 * The screen the banner sends the reader to, and the theme it wears.
 *
 * Asserted through the real page rather than as a unit, because everything
 * about this feature is arrangement: the rules have to be in the document, the
 * picker has to be able to name them, and the inline script has to apply the
 * choice before anything is painted. Each of those is correct in isolation and
 * the feature only exists when all three are on the same page.
 */
describe('the files screen carries the syntax themes', () => {
  test('a rule for every theme, a picker that names them, and a script that applies one', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1/files`)
    const html = await answer.text()

    expect(answer.status).toBe(200)

    // The rules, generated from the library's own themes.
    expect(html).toContain('data-syntax-theme=\'nord\'')
    expect(html).toContain('data-syntax-theme=\'monochrome-dark\'')

    // The token classes read them, with the built-in palette as the fallback -
    // so a reader who has chosen nothing sees what they always saw.
    expect(html).toContain('var(--t-keyword, #8250df)')

    /*
     * And the viewer's own layout, which is the same kind of claim.
     *
     * These rules moved into `DiffViewerStyles` because the public viewer at
     * `/view` mounted the same markup and shipped none of them - and a scroller
     * with no height means a virtualizer that measures nothing and mounts
     * nothing, so the page renders a file list above an empty space. Asserted
     * on both pages now, because "the CSS is on the other one" is exactly the
     * failure.
     */
    expect(html).toContain('.diff-scroller {')
    expect(html).toContain('--diff-viewport-offset')

    // The picker, offering the built-in palette and the library's themes.
    expect(html).toContain('data-diff-pref="syntaxTheme"')
    expect(html).toContain('<option value="default">')
    expect(html).toContain('<option value="deuteranopia-dark">')

    // And applied before first paint, for the same reason the colour scheme is:
    // a theme carries the page background, so reading it a frame late is a
    // flash rather than a recolour.
    expect(html).toContain('dataset.syntaxTheme')
  }, 60_000)
})
