// A review thread, and a branch that moves under it.
//
// `reanchor` is tested as a pure function against hand-written patches, which
// covers the arithmetic. What it cannot cover is whether the thing that ends up
// on the reader's screen is anchored against the diff that is actually being
// shown - and that is the failure mode with teeth. A comment left on line 4 and
// rendered on line 4 of a rebased branch, where line 4 is now something else,
// is a reviewer's words attached to code they never read.
//
// So this rebases and force-pushes for real, then asks the loader the question
// the page asks it. The three cases named in the roadmap - rebase, amend,
// force-push - are one situation as far as the code is concerned (the head sha
// changed and the diff is different), which is precisely why they are worth
// running through the real path once rather than three times as unit tests.
//
// Like the rest of tests/e2e it needs a database and git, and skips itself
// loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = {
  userId: 0,
  repositoryId: 0,
  pullRequestId: 0,
  threadId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  work: '',
  baseSha: '',
}

let available = false

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

/**
 * Where the thread lands on the page, right now.
 *
 * Through `loadReviewThreads` and `anchorThreadsToFile`, which is the pair the
 * review screen calls - not through `reanchor` directly. Anchoring against the
 * right diff is the half a unit test cannot check.
 */
async function anchorNow(): Promise<{ line: number | null, outdated: boolean } | null> {
  const { streamMergeBaseDiff } = await import('../../app/Actions/Git/diffStream')
  const { parseDiff } = await import('../../app/Actions/Pull/diff')
  const { anchorThreadsToFile, loadReviewThreads } = await import('../../app/Actions/Pull/loadThreads')

  const row: any = await (globalThis as any).db
    .selectFrom('pull_requests')
    .select(['base_sha', 'head_sha'])
    .where('id', '=', created.pullRequestId)
    .executeTakeFirst()

  const diff = await streamMergeBaseDiff(created.diskPath, String(row.base_sha), String(row.head_sha))
  if (!diff)
    return null

  let patch = ''
  for await (const chunk of diff.chunks)
    patch += chunk

  const file = parseDiff(patch).find(one => one.path === 'greet.ts')
  if (!file)
    return null

  const threads = await loadReviewThreads({
    pullRequestId: created.pullRequestId,
    renderBody: body => body,
    trackTo: { diskPath: created.diskPath, headSha: String(row.head_sha) },
  })
  const anchored = anchorThreadsToFile(threads, file)

  return anchored.length === 0
    ? null
    : { line: anchored[0]!.line ?? null, outdated: Boolean(anchored[0]!.outdated) }
}

/** Point the pull request at whatever `change` is now. */
async function refreshHead(): Promise<string> {
  const sha = await git(created.work, 'rev-parse', 'change')

  await (globalThis as any).db
    .updateTable('pull_requests')
    .set({ head_sha: sha })
    .where('id', '=', created.pullRequestId)
    .execute()

  return sha
}

const original = [
  'export function greet(name: string): string {',
  '  const greeting = \'hello\'',
  '  const punctuation = \'!\'',
  '  return `${greeting} ${name}${punctuation}`',
  '}',
  '',
].join('\n')

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-anchor-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('anc')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({
        name: 'Anchor Reader',
        email: `${created.handle}@example.com`,
        handle: created.handle,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the thread anchoring end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolvedPath.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    created.work = join(created.temp, 'seed')
    mkdirSync(created.work)
    await git(created.work, 'init', '--initial-branch=main')
    writeFileSync(join(created.work, 'greet.ts'), original)
    await git(created.work, 'add', '.')
    await git(created.work, 'commit', '-m', 'the base')
    created.baseSha = await git(created.work, 'rev-parse', 'HEAD')

    // The branch changes the greeting on line 2. That is the line the review
    // is about, and the line every assertion below follows.
    await git(created.work, 'checkout', '-b', 'change')
    writeFileSync(join(created.work, 'greet.ts'), original.replace('\'hello\'', '\'good morning\''))
    await git(created.work, 'add', '.')
    await git(created.work, 'commit', '-m', 'change the greeting')

    await git(created.work, 'push', created.diskPath, 'main')
    await git(created.work, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Change the greeting',
        body: 'Opened by the thread anchoring end to end test.',
        author_id: created.userId,
        state: 'open',
        head_branch: 'change',
        head_sha: await git(created.work, 'rev-parse', 'change'),
        base_branch: 'main',
        base_sha: created.baseSha,
        draft: false,
        additions: 1,
        deletions: 1,
        changed_files: 1,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    const thread: any = await (globalThis as any).db
      .insertInto('review_threads')
      .values({
        pull_request_id: created.pullRequestId,
        path: 'greet.ts',
        line: 2,
        side: 'right',
        original_line: 2,
        original_commit_sha: await git(created.work, 'rev-parse', 'change'),
        resolved: false,
        outdated: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.threadId = Number(thread?.id)

    await (globalThis as any).db
      .insertInto('review_comments')
      .values({
        review_thread_id: created.threadId,
        author_id: created.userId,
        body: 'Is good morning right for an evening build?',
      })
      .execute()

    available = true
  }
  catch (error) {
    console.warn(`[thread-anchoring] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    if (created.threadId) {
      await db.deleteFrom('review_comments').where('review_thread_id', '=', created.threadId).execute()
      await db.deleteFrom('review_threads').where('id', '=', created.threadId).execute()
    }

    if (created.pullRequestId)
      await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  finally {
    if (created.diskPath)
      removeRepositoryDirectory(created.diskPath)
    if (created.temp)
      rmSync(created.temp, { recursive: true, force: true })
  }
})

describe('a thread on a branch that moves', () => {
  test('starts on the line it was written about', async () => {
    if (!available)
      return

    expect(await anchorNow()).toEqual({ line: 2, outdated: false })
  })

  /**
   * An amend rewrites the commit and leaves the change where it was. The thread
   * must not move and must not go outdated: nothing about the line it is on has
   * changed, only the sha that carries it.
   */
  test('an amend that leaves the line alone leaves the thread alone', async () => {
    if (!available)
      return

    const before = await git(created.work, 'rev-parse', 'change')
    await git(created.work, 'commit', '--amend', '-m', 'change the greeting, better message')
    await git(created.work, 'push', '--force', created.diskPath, 'change')
    await refreshHead()

    expect(await git(created.work, 'rev-parse', 'change')).not.toBe(before)
    expect(await anchorNow()).toEqual({ line: 2, outdated: false })
  })

  /**
   * The case with teeth.
   *
   * The base moves and inserts a line above the change, the branch is rebased
   * onto it, and every commit sha is different. The line the thread is about is
   * now line 3, and a comment left on line 2 would be a reviewer's words
   * attached to code they never read.
   *
   * Getting this right needs the diff from the head the thread was written
   * against to the current one - two dots, not three, because a rebase moves
   * the merge base and three dots would report that nothing happened.
   */
  test('a rebase that pushes the line down carries the thread with it', async () => {
    if (!available)
      return

    await git(created.work, 'checkout', 'main')
    writeFileSync(join(created.work, 'greet.ts'), `// added by the base\n${original}`)
    await git(created.work, 'add', '.')
    await git(created.work, 'commit', '-m', 'the base grows a line')
    const newBase = await git(created.work, 'rev-parse', 'HEAD')

    await git(created.work, 'checkout', 'change')
    await git(created.work, 'rebase', 'main')
    await git(created.work, 'push', created.diskPath, 'main')
    await git(created.work, 'push', '--force', created.diskPath, 'change')

    await (globalThis as any).db
      .updateTable('pull_requests')
      .set({ base_sha: newBase })
      .where('id', '=', created.pullRequestId)
      .execute()

    await refreshHead()

    expect(await anchorNow()).toEqual({ line: 3, outdated: false })
  })

  /**
   * The author took the change back. There is no line for the thread any more,
   * and it is marked outdated rather than dropped - somebody's question about
   * why the greeting changed is still worth reading once it no longer does.
   */
  test('a force-push that removes the change outdates the thread rather than losing it', async () => {
    if (!available)
      return

    writeFileSync(join(created.work, 'greet.ts'), `// added by the base\n${original}`)
    await git(created.work, 'add', '.')
    await git(created.work, 'commit', '-m', 'put the greeting back')
    await git(created.work, 'push', '--force', created.diskPath, 'change')
    await refreshHead()

    const anchored = await anchorNow()

    // The file has no changed lines left, so there is no diff to anchor into.
    // Either answer is the thread surviving: it is on the page as outdated, or
    // the file is not in the diff at all and the conversation page shows it
    // under its original line. What must not happen is a line number that
    // points at code nobody commented on.
    expect(anchored === null || anchored.outdated).toBe(true)

    const still: any = await (globalThis as any).db
      .selectFrom('review_threads')
      .select(['id'])
      .where('id', '=', created.threadId)
      .executeTakeFirst()

    expect(still).toBeTruthy()
  })
})
