// The review page with the script engine switched off, through the real routes.
//
// Phase 14's standard says a fifteen file pull request stays readable with no
// JavaScript, and that claim is the reason the server renders rows at all. It
// is also the easiest claim in the file to break without noticing: every change
// to the viewer is tested in a browser that runs scripts, so a page that has
// quietly become a mount point for a client renderer looks perfect right up
// until somebody opens it behind a corporate proxy, on a phone with a failed
// bundle, or in a text browser.
//
// So this asks the only question that settles it: what is *in the HTML*. Not
// whether the page looks right - it fetches the markup and counts what is in
// it. A page that renders correctly by running a script would pass a screenshot
// and fails here, which is the entire point.
//
// Like the rest of tests/e2e it needs the router, a database and a socket, and
// skips itself loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

/** Everything this run created, removed in afterAll however it ends. */
const created = {
  userId: 0,
  repositoryId: 0,
  pullRequestId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
}

let port = 0
let available = false
let server: any = null
/** The page under test, fetched once in beforeAll and asserted on many times. */
let page = ''
/**
 * The same page with the tags taken out.
 *
 * Highlighted code is not contiguous text: `export function greet` arrives as
 * a keyword span, a text span and another text span, so asking the markup
 * whether it contains that phrase always answers no - including on a page that
 * renders it perfectly. Stripping the tags asks the question the reader would
 * ask, which is whether the code is on the page, and leaves the markup-level
 * assertions to the tests that are actually about markup.
 */
let text = ''
let status = 0

/** A run-unique handle, so two runs cannot collide and neither can a leftover. */
function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Run git without blocking the event loop.
 *
 * The server under test runs in this process, so a synchronous child blocks the
 * loop that has to answer its own requests. `git-http.test.ts` learned this the
 * expensive way and the note there is worth reading.
 */
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
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
    },
  })

  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return stdout.trim()
}

/**
 * A file with something in it worth colouring.
 *
 * Keywords, a string and a comment, because "the rows are in the HTML" and
 * "the rows are *highlighted* in the HTML" are different claims and the second
 * one needs something that would be highlighted.
 */
const before = `export function greet(name: string): string {
  // A comment, so a comment token has somewhere to come from.
  const greeting = 'hello'
  return \`\${greeting} \${name}\`
}
`

const after = `export function greet(name: string): string {
  // A comment, so a comment token has somewhere to come from.
  const greeting = 'good morning'
  return \`\${greeting} \${name}!\`
}
`

const COMMENT_BODY = 'This line is the one the end to end test is about.'

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-review-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()

    // One query decides whether this file can run at all. A missing database is
    // an ordinary state for a checkout to be in and must read as "skipped".
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('rev')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({
        name: 'Review Reader',
        email: `${created.handle}@example.com`,
        handle: created.handle,
        password: 'x',
      })
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
        description: 'created by the review page end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    // Two branches with one file changed between them, pushed over the
    // filesystem. The wire protocol is `git-http.test.ts`'s subject, and a
    // fixture that depends on the thing another test is proving is a fixture
    // that fails for reasons of its own.
    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'greet.ts'), before)
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'add greet')
    const baseSha = await git(work, 'rev-parse', 'HEAD')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'greet.ts'), after)
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'change the greeting')
    const headSha = await git(work, 'rev-parse', 'HEAD')

    await git(work, 'push', created.diskPath, 'main')
    await git(work, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Change the greeting',
        body: 'Opened by the review page end to end test.',
        author_id: created.userId,
        state: 'open',
        head_branch: 'change',
        head_sha: headSha,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 2,
        deletions: 2,
        changed_files: 1,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    // A thread on the changed line, with a comment in it. The page has to
    // render both without a script, which is the half of this that is about
    // reviewing rather than about reading.
    const thread: any = await (globalThis as any).db
      .insertInto('review_threads')
      .values({
        pull_request_id: created.pullRequestId,
        path: 'greet.ts',
        line: 3,
        side: 'right',
        resolved: false,
        outdated: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    await (globalThis as any).db
      .insertInto('review_comments')
      .values({
        review_thread_id: Number(thread?.id),
        author_id: created.userId,
        body: COMMENT_BODY,
      })
      .execute()

    const response = await fetch(
      // The files tab: the page grew real tabs, conversation is the default,
      // and the server-rendered diff this file exists to hold lives here.
      `http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1?tab=files`,
      // No `Accept: application/json`, and nothing that runs a script. This is
      // what a browser with JavaScript off sends.
      { headers: { Accept: 'text/html' } },
    )

    status = response.status
    page = await response.text()
    text = page.replace(/<[^>]+>/g, '')

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
  // Booting the router, connecting to Postgres and building two commits do not
  // fit in bun's default five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  try {
    // The foreign keys cascade, so the repository takes the pull request, the
    // thread and the comment with it.
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    // And the owner's directory, which this repository was the only thing in.
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

describe('the review page with no JavaScript', () => {
  test('is served at all', () => {
    if (!available)
      return

    expect(status).toBe(200)
    expect(page).toContain('<html')
  })

  /**
   * The claim the server-rendered path exists for. Not "a container the rows
   * will go into" - the rows themselves, with the code in them.
   */
  test('has the changed lines in the markup, both sides of them', () => {
    if (!available)
      return

    expect(text).toContain('good morning')
    expect(text).toContain('hello')
  })

  test('and the unchanged context around them, so the change can be read', () => {
    if (!available)
      return

    expect(text).toContain('export function greet')
  })

  /**
   * Highlighted, not merely present. If the tokens were being applied by a
   * script this page would carry the text and none of the classes, which is
   * exactly the regression this file exists to catch.
   */
  test('the code is already coloured, rather than waiting for a highlighter', () => {
    if (!available)
      return

    expect(page).toMatch(/class="t-(keyword|string|comment)"/)
  })

  test('the row markup is rows, not a placeholder for some', () => {
    if (!available)
      return

    // More than a couple, so a single stray table row somewhere in the chrome
    // cannot satisfy this.
    expect(page.split('<tr').length - 1).toBeGreaterThan(4)
  })

  /**
   * The review half. A diff nobody can comment on is a file viewer.
   */
  test('the review thread and its comment are in the page', () => {
    if (!available)
      return

    expect(text).toContain(COMMENT_BODY)
    expect(page).toContain('thread-row')
  })

  test('replying is a form, so it works with nothing to run it', () => {
    if (!available)
      return

    expect(page).toMatch(/<form[^>]*method="post"/i)
    expect(page).toMatch(/<textarea/i)
  })

  /**
   * A page whose only submit control is a button wired up by a script is a
   * page that reads but cannot answer.
   */
  test('and the form has a plain submit control rather than a scripted one', () => {
    if (!available)
      return

    expect(page).toMatch(/<button[^>]*type="submit"|<input[^>]*type="submit"/i)
  })
})

/*
 * The same question the run page already asks, asked of the pull request page,
 * which was the one page in the product answering it wrongly.
 *
 * A soft 404 is not a cosmetic problem here. This instance is walked by
 * crawlers - that is what took the site down twice - and a 200 on
 * `/owner/repo/pull/999999` tells them every number in the sequence is a page
 * worth fetching, which is an unbounded space dressed up as content.
 */
describe('a pull request number nobody has', () => {
  test('is a 404 rather than an empty page under a 200', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/999999`, {
      headers: { Accept: 'text/html' },
    })

    expect(answer.status).toBe(404)
  })

  test('and says where to go instead, rather than only saying no', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/999999`, {
      headers: { Accept: 'text/html' },
    })
    const html = await answer.text()

    expect(html).toContain(`/${created.handle}/${created.name}/pulls`)
  })
})
