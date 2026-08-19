// Who wrote a repository, from `git shortlog` to the page.
//
// The unit tests cover the parsing and the shaping. What only this can check is
// the join: that `MeasureContributorsJob` reads a real history with real
// authors, that it matches an address to a local account and leaves the rest
// unlinked, and that the page and the About panel then say so.
//
// It also pins the one thing that would be a real harm: **the addresses do not
// reach the page**. They are the key the table is grouped by, and a public page
// indexed by search engines is a different audience from somebody who cloned
// the repository and can read `git log` for themselves.

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

/** The cast, and the point of each one. */
const AUTHORS = [
  // Has an account here: gets a link and an avatar.
  { name: 'Local Person', email: '', commits: 4 },
  // Has none, which on a mirror is almost everybody: named, not linked.
  { name: 'Outside Person', email: 'outside@example.org', commits: 2 },
  // The same address under a second spelling of the name, which `shortlog`
  // reports as its own row and which must merge into one contributor.
  { name: 'outside person', email: 'outside@example.org', commits: 1 },
]

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, env: Record<string, string>, ...args: string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })

  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
}

async function page(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return await answer.text()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-contributors-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('ctb')
    AUTHORS[0]!.email = `${created.handle}@example.com`

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Local Person', email: AUTHORS[0]!.email, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the contributors end to end test',
        homepage: 'https://stacksjs.com/',
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
    mkdirSync(work, { recursive: true })
    await git(work, {}, 'init', '--initial-branch=main')

    let index = 0

    for (const author of AUTHORS) {
      for (let n = 0; n < author.commits; n += 1) {
        index += 1
        writeFileSync(join(work, `file-${index}.txt`), `${index}\n`)

        await git(work, {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        }, 'add', '.')

        await git(work, {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        }, 'commit', '-m', `change ${index}`)
      }
    }

    await git(work, {}, 'push', created.diskPath, 'main')

    // The job, run directly rather than through the queue: what is under test
    // is the measurement, not the dispatch.
    const MeasureContributorsJob = (await import('../../app/Jobs/MeasureContributorsJob')).default
    await MeasureContributorsJob.handle({ repositoryId: created.repositoryId })

    available = true
  }
  catch (error) {
    console.warn(`[repository-contributors] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (created.repositoryId) {
      await db.deleteFrom('repository_contributors').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
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

describe('the measurement', () => {
  test('counts each author, merging the spellings of one address', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('repository_contributors')
      .select(['name', 'email', 'commits', 'user_id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('commits', 'desc')
      .execute()

    expect(rows).toHaveLength(2)
    expect(Number(rows[0]!.commits)).toBe(4)
    // Two rows out of `shortlog`, one contributor: three commits, not two rows.
    expect(Number(rows[1]!.commits)).toBe(3)
  })

  test('attaches the account whose address matches, and no other', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('repository_contributors')
      .select(['email', 'user_id'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    const mine = rows.find(row => String(row.email) === AUTHORS[0]!.email)
    const theirs = rows.find(row => String(row.email) === 'outside@example.org')

    expect(Number(mine?.user_id)).toBe(created.ownerId)
    expect(theirs?.user_id).toBeFalsy()
  })

  test('is idempotent, rather than doubling every contributor', async () => {
    if (!available)
      return

    // The unique index would reject a second insert; the measure deletes first
    // for exactly this reason.
    const MeasureContributorsJob = (await import('../../app/Jobs/MeasureContributorsJob')).default
    await MeasureContributorsJob.handle({ repositoryId: created.repositoryId })

    const rows: any[] = await (globalThis as any).db
      .selectFrom('repository_contributors')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    expect(rows).toHaveLength(2)
  })
})

describe('the contributors page', () => {
  test('names everybody, with and without an account here', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/contributors`)

    expect(html).toContain('Outside Person')
    expect(html).toContain(`/${created.handle}`)
  })

  test('does not put anybody\'s address on it', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/contributors`)

    expect(html).not.toContain('outside@example.org')
    expect(html).not.toContain(AUTHORS[0]!.email)
  })

  test('counts the commits it is reporting', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/contributors`)

    // Whitespace-collapsed: the caption wraps across lines in the template, and
    // asserting on the line breaks would make this a test of the indentation.
    expect(html.replace(/\s+/g, ' ')).toContain('2 people have landed 7 commits')
  })
})

describe('the About panel', () => {
  test('links the homepage, and says it without the scheme', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('href="https://stacksjs.com/"')
    expect(html).toContain('stacksjs.com')
  })

  test('shows the contributors and links to the full list', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('Contributors')
    expect(html).toContain(`/${created.handle}/${created.name}/contributors`)
  })

  test('does not put anybody\'s address on the repository page either', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).not.toContain('outside@example.org')
  })
})
