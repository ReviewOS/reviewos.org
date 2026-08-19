// The suggested-reviewers panel, through the real routes, with the credential
// a browser actually carries.
//
// The ranking is unit tested and the git-to-forge joins are covered by
// suggest-reviewers.test.ts, which calls the action in process. What neither
// can see is the surface this file pins: the endpoint answering a fetch whose
// only credential is a cookie (docs/todo's "a signed-in browser is not a
// signed-in test client" - every other caller of this endpoint holds a
// bearer), and the page offering the panel without paying for it.
//
// The panel's design constraint is that the `git log` is spent when the reader
// opens it, never at render. No browser here runs the script, so that is
// asserted the only way markup can assert it: the rendered page carries the
// panel and the URL it would ask, and none of the answer.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = {
  authorId: 0,
  expertId: 0,
  repositoryId: 0,
  handle: '',
  expertHandle: '',
  authorToken: '',
  name: '',
  diskPath: '',
  temp: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Commit as a specific person, which is what the suggester reads. */
async function git(cwd: string, as: { name: string, email: string } | null, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: as?.name ?? 'E2E',
      GIT_AUTHOR_EMAIL: as?.email ?? 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      GIT_TERMINAL_PROMPT: '0',
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

/** The read a browser makes: a cookie, and nothing else. */
async function fetchPage(path: string, cookieToken?: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
  })

  return { status: answer.status, html: await answer.text() }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-suggest-panel-'))

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
    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, handle: string, email: string }> => {
      const handle = unique(prefix)
      const email = `${handle}@example.com`
      const row: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Panel Tester', email, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle, email }
    }

    const author = await make('spa')
    const expert = await make('spe')

    created.authorId = author.id
    created.handle = author.handle
    created.expertId = expert.id
    created.expertHandle = expert.handle

    const issued: any = await createToken(author.id, 'suggested reviewers panel test')
    created.authorToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: created.name,
        description: 'created by the suggested reviewers panel end to end test',
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
    await git(work, null, 'init', '--initial-branch=main')

    writeFileSync(join(work, 'touched.ts'), 'export const a = 0\n')
    await git(work, null, 'add', '.')
    await git(work, null, 'commit', '-m', 'the base')

    // The expert's history is what the endpoint will name, when asked.
    for (let round = 1; round <= 3; round += 1) {
      writeFileSync(join(work, 'touched.ts'), `export const a = ${round}\n`)
      await git(work, expert, 'add', '.')
      await git(work, expert, 'commit', '-m', `expert round ${round}`)
    }

    await git(work, null, 'push', created.diskPath, 'main')
    const baseSha = await git(work, null, 'rev-parse', 'HEAD')

    await git(work, null, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'touched.ts'), 'export const a = 99\n')
    await git(work, { name: 'Author', email: `${created.handle}@example.com` }, 'add', '.')
    await git(work, { name: 'Author', email: `${created.handle}@example.com` }, 'commit', '-m', 'change the touched file')
    const headSha = await git(work, null, 'rev-parse', 'HEAD')
    await git(work, null, 'push', created.diskPath, 'change')

    await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Change the touched file',
        body: 'Opened by the suggested reviewers panel end to end test.',
        author_id: created.authorId,
        state: 'open',
        head_branch: 'change',
        head_sha: headSha,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 1,
        deletions: 1,
        changed_files: 1,
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

    for (const id of [created.authorId, created.expertId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('users').where('id', '=', id).execute()
    }
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

describe('the suggested reviewers panel', () => {
  /**
   * The fetch the panel's script makes, with the credential a browser holds.
   * Every other caller of this endpoint in the suite authenticates with a
   * bearer, and a bearer works whether or not the cookie path does.
   */
  test('the endpoint answers a cookie-only fetch with the expert and the why', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/pulls/suggested-reviewers?owner=${created.handle}&repo=${created.name}&number=1`,
      { headers: { Accept: 'application/json', Cookie: `auth-token=${created.authorToken}` } },
    )

    expect(answer.status).toBe(200)

    const body: any = await answer.json()
    const suggestion = (body?.suggestions ?? []).find((entry: any) => entry.handle === created.expertHandle)

    expect(suggestion).toBeDefined()
    // The stable prefix only: the "last Nd ago" half reads the clock.
    expect(String(suggestion.reason)).toContain('3 commits here')
  }, 30_000)

  test('the page offers the panel to a signed-in reviewer, without paying for it', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage(`/${created.handle}/${created.name}/pull/1`, created.authorToken)

    expect(status).toBe(200)
    expect(html).toContain('data-suggested-reviewers')

    // The URL the script would ask, addressed by the server so the client does
    // not know how a pull request is named.
    expect(html).toContain('/api/repos/pulls/suggested-reviewers?owner=')
    expect(html).toContain(`number=1`)

    // And none of the answer. The expert's handle appearing here would mean
    // the git log ran at render time, which is the cost the endpoint exists
    // to defer.
    expect(html).not.toContain(created.expertHandle)
  }, 30_000)

  /**
   * The reader's credential stays out of the document. stx's client bridge
   * seeds any identifier a client script shares with the server scope into
   * the page, and the server scope holds the request headers - so a script
   * that so much as says `headers` serializes the session cookie into the
   * HTML. That shipped, briefly, as `fetch(url, { headers: ... })`; this is
   * the assertion that keeps it shipped out.
   */
  test('the page never carries the session token that fetched it', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}/${created.name}/pull/1`, created.authorToken)

    expect(html).not.toContain(created.authorToken)
    expect(html).not.toContain('auth-token')
  }, 30_000)

  test('the closed panel already says what it is, for readers without scripts', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}/${created.name}/pull/1`, created.authorToken)

    expect(html).toContain('Who has worked on these files.')
  }, 30_000)

  test('a reader with no session is not offered a panel they cannot use', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage(`/${created.handle}/${created.name}/pull/1`)

    expect(status).toBe(200)
    expect(html).not.toContain('data-suggested-reviewers')
  }, 30_000)
})
