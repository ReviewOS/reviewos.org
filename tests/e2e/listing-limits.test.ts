// Pages that list a change or a directory draw a bounded number of rows.
//
// Rendering is single-threaded, so a page with no ceiling is a page that holds
// the server for as long as the repository is large: a commit page drawing all
// 2,287 files of one import took eight seconds, and a crawler walking history
// queued enough of them that the liveness check restarted the instance
// (ReviewOS, 2026-10-20). The totals still count every file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { MAX_LISTED_ROWS } from '../../app/Actions/Browse/load'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const FILES = MAX_LISTED_ROWS + 5

const created = { userId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', work: '', sha: '' }

let available = false
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    },
  })
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}`)

  return out.trim()
}

async function page(path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}${path}`, {
    headers: { Accept: 'text/html' },
  })

  return await response.text()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { serveForTest } = await import('../helpers/server')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    port = (await serveForTest()).port

    const { repositoryPath } = await import('../../app/Actions/Git/storage')

    created.handle = unique('lim')
    created.name = unique('repo')

    const user: any = await db
      .insertInto('users')
      .values({ name: 'Ada Lovelace', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.userId = Number(user?.id)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the listing limits test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    // One commit that adds more files than a page lists, all in the root.
    created.work = mkdtempSync(join(tmpdir(), 'reviewos-limits-'))
    await git(created.work, ['init', '--quiet', '--initial-branch=main'])
    for (let i = 0; i < FILES; i++)
      writeFileSync(join(created.work, `file-${String(i).padStart(4, '0')}.txt`), `${i}\n`)
    await git(created.work, ['add', '.'])
    await git(created.work, ['commit', '--quiet', '-m', 'import'])
    created.sha = await git(created.work, ['rev-parse', 'HEAD'])

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await git(created.work, ['clone', '--quiet', '--bare', created.work, created.diskPath])

    available = true
  }
  catch (error) {
    console.warn(`[listing-limits] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the directories still go, below */ }

  if (created.work)
    rmSync(created.work, { recursive: true, force: true })

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    try {
      removeRepositoryOwnerDirectory(created.diskPath)
    }
    catch { /* not empty, which is somebody else's repository */ }
  }
})

describe('a commit that changes more files than a page lists', () => {
  test('draws the first rows and says how many there are', async () => {
    if (!available)
      return

    const html = await page(`/commit/${created.sha}`)

    expect(html.match(/class="file-row"/g)?.length).toBe(MAX_LISTED_ROWS)
    expect(html).toContain(`${FILES} files changed`)
    expect(html).toContain(`Listing the first ${MAX_LISTED_ROWS} changed files of ${FILES}`)
    expect(html).toContain('file-0000.txt')
    expect(html).not.toContain(`file-${String(FILES - 1).padStart(4, '0')}.txt`)
  }, 60_000)
})

describe('a directory with more entries than a page lists', () => {
  test('draws the first rows and says the listing is incomplete', async () => {
    if (!available)
      return

    const html = await page('')

    expect(html).toContain('file-0000.txt')
    expect(html).not.toContain(`file-${String(FILES - 1).padStart(4, '0')}.txt`)
    expect(html).toContain('This directory has more entries than the page can list')
  }, 60_000)
})
