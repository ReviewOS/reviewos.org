// Auto-merge, through the real routes: armed while blocked, fired by the
// event that satisfies the last requirement.
//
// The attempt IS MergePullRequestAction invoked as the arming user, so every
// merge rule is exercised by the same code the button presses. What this file
// holds is the arc the feature exists for: arming a blocked pull request does
// not merge it, the approval that satisfies the rule merges it without anyone
// pressing anything, and the merge is recorded as the arming user's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  reviewerId: 0,
  ownerToken: '',
  reviewerToken: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  pullRequestId: 0,
}

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

async function post(path: string, token: string, form: Record<string, string>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
    },
    body: new URLSearchParams({ owner: created.handle, repo: created.name, ...form }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function pullRow(): Promise<any> {
  return await (globalThis as any).db
    .selectFrom('pull_requests')
    .select(['state', 'merged_by_id', 'auto_merge_strategy', 'merge_commit_sha'])
    .where('id', '=', created.pullRequestId)
    .executeTakeFirst()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-automerge-'))

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

    const make = async (prefix: string): Promise<{ id: number, handle: string, token: string }> => {
      const handle = unique(prefix)
      const row: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Auto Merge', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'auto merge test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('amo')
    const reviewer = await make('amr')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.reviewerId = reviewer.id
    created.reviewerToken = reviewer.token

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the auto merge end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolvedPath.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // One approval required on main. The rule auto-merge will wait behind.
    await (globalThis as any).db
      .insertInto('protected_branches')
      .values({
        repository_id: created.repositoryId,
        pattern: 'main',
        required_approvals: 1,
      })
      .execute()

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(work)
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first')
    const baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'second')
    const headSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Auto merge fixture',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: headSha,
        base_branch: 'main',
        base_sha: baseSha,
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

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

    for (const id of [created.ownerId, created.reviewerId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* the temp files still go, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    try {
      rmdirSync(resolve(created.diskPath, '..'))
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

describe('auto-merge', () => {
  test('a strategy the repository disallows is refused at arm time', async () => {
    if (!available)
      return

    await (globalThis as any).db
      .updateTable('repositories')
      .set({ allow_rebase_merge: false })
      .where('id', '=', created.repositoryId)
      .execute()

    const { status } = await post('/api/repos/pulls/auto-merge', created.ownerToken, { number: '1', strategy: 'rebase' })
    expect(status).toBe(422)

    await (globalThis as any).db
      .updateTable('repositories')
      .set({ allow_rebase_merge: true })
      .where('id', '=', created.repositoryId)
      .execute()
  }, 30_000)

  test('arming a blocked pull request arms it and merges nothing', async () => {
    if (!available)
      return

    const { status, body } = await post('/api/repos/pulls/auto-merge', created.ownerToken, { number: '1', strategy: 'squash' })

    expect(status).toBe(200)
    expect(body?.armed).toBe(true)
    expect(body?.merged).toBe(false)

    const row = await pullRow()
    expect(String(row?.state)).toBe('open')
    expect(String(row?.auto_merge_strategy)).toBe('squash')
  }, 30_000)

  test('disarming holds even when the last requirement lands', async () => {
    if (!available)
      return

    const disarm = await post('/api/repos/pulls/auto-merge/disarm', created.ownerToken, { number: '1' })
    expect(disarm.status).toBe(200)

    // The approval that would have fired it.
    const review = await post('/api/repos/pulls/reviews', created.reviewerToken, { number: '1', state: 'approved', body: '' })
    expect(review.status).toBe(201)

    expect(String((await pullRow())?.state)).toBe('open')

    // Withdrawn for the next test: the arc it asserts starts blocked.
    await (globalThis as any).db
      .deleteFrom('pull_request_reviews')
      .where('pull_request_id', '=', created.pullRequestId)
      .execute()
  }, 30_000)

  test('the approval that satisfies the rule merges it, as the arming user', async () => {
    if (!available)
      return

    const arm = await post('/api/repos/pulls/auto-merge', created.ownerToken, { number: '1', strategy: 'squash' })
    expect(arm.body?.merged).toBe(false)

    const review = await post('/api/repos/pulls/reviews', created.reviewerToken, { number: '1', state: 'approved', body: '' })
    expect(review.status).toBe(201)

    const row = await pullRow()
    expect(String(row?.state)).toBe('merged')
    // Recorded as the arming user's merge, not the reviewer's: the reviewer
    // approved; the arming user is the one who scheduled the press.
    expect(Number(row?.merged_by_id)).toBe(created.ownerId)

    const tip = await git(created.diskPath, 'rev-parse', 'refs/heads/main')
    expect(tip).toBe(String(row?.merge_commit_sha))
  }, 30_000)
})

/**
 * A whole review in one request: comments plus a verdict, atomically.
 *
 * Living in this file because it needs exactly the fixture this file already
 * builds - an open pull request against a real repository, and a reviewer who
 * is not its author. Duplicating two hundred lines of git setup to keep the
 * filename tidy would be the worse trade.
 *
 * The shape exists for callers with no drafts to publish. The browser writes
 * pending threads as the reviewer types and submits them together; an agent
 * assembles its comments in memory and has nowhere to put them until it
 * submits. Twelve round trips is twelve chances to leave half a review behind.
 */
describe('submitting a whole review at once', () => {
  /*
   * Its own pull request, number 2.
   *
   * The tests above merge number 1, so sharing it would make this block pass or
   * fail depending on which ran first - and the failure is a 409 that reads
   * like a bug in the endpoint rather than in the fixture.
   */
  let reviewablePullId = 0

  beforeAll(async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 2,
        title: 'Whole review fixture',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: 'b'.repeat(40),
        base_branch: 'main',
        base_sha: 'a'.repeat(40),
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
      })
      .returning(['id'])
      .executeTakeFirst()

    reviewablePullId = Number(row?.id)
  })

  /** JSON rather than the form encoding above, because `comments` is an array. */
  async function postJson(path: string, token: string, body: Record<string, unknown>) {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('writes every comment and the verdict together', async () => {
    if (!available)
      return

    const submitted = await postJson('/api/repos/pulls/reviews', created.reviewerToken, {
      number: '2',
      state: 'commented',
      body: 'a few things',
      comments: [
        { path: 'README.md', line: 1, side: 'right', body: 'this line' },
        { path: 'README.md', line: 2, side: 'right', body: 'and this one' },
      ],
    })

    expect(submitted.status).toBe(201)
    expect(submitted.body?.comments).toHaveLength(2)

    // Each comment is a real thread, the same shape the browser writes - a
    // comment left by an agent and one left by a person have to be the same
    // kind of object, or every reader of them grows a special case.
    const threads: any[] = await (globalThis as any).db
      .selectFrom('review_threads')
      .select(['id', 'path', 'line', 'side', 'original_commit_sha'])
      .where('pull_request_id', '=', reviewablePullId)
      .execute()

    expect(threads.length).toBeGreaterThanOrEqual(2)
    // Anchored to the head the review was written against, which is what lets a
    // thread be marked outdated later rather than drifting onto whatever line
    // now occupies that number.
    expect(threads.every(thread => thread.original_commit_sha)).toBe(true)
  })

  test('refuses the whole thing when any comment is invalid', async () => {
    if (!available)
      return

    const before: any[] = await (globalThis as any).db
      .selectFrom('review_threads')
      .select(['id'])
      .where('pull_request_id', '=', reviewablePullId)
      .execute()

    const refused = await postJson('/api/repos/pulls/reviews', created.reviewerToken, {
      number: '2',
      state: 'commented',
      body: 'mixed',
      comments: [
        { path: 'README.md', line: 1, side: 'right', body: 'fine' },
        { path: '', line: 0, side: 'sideways', body: '' },
      ],
    })

    expect(refused.status).toBe(422)

    // Nothing was written, including the comment that was fine. Half a review
    // is the failure this shape exists to prevent.
    const after: any[] = await (globalThis as any).db
      .selectFrom('review_threads')
      .select(['id'])
      .where('pull_request_id', '=', reviewablePullId)
      .execute()

    expect(after).toHaveLength(before.length)
  })

  test('and names every problem, not just the first', async () => {
    if (!available)
      return

    /*
     * A caller sending twelve comments with two mistakes should learn about
     * both. Fixing the first otherwise only earns them the second error on the
     * next attempt, and an agent doing that is an agent in a loop.
     */
    const refused = await postJson('/api/repos/pulls/reviews', created.reviewerToken, {
      number: '2',
      state: 'commented',
      body: 'x',
      comments: [
        { path: '', line: 1, side: 'right', body: 'no path' },
        { path: 'a.ts', line: 0, side: 'right', body: 'no line' },
      ],
    })

    expect(refused.status).toBe(422)
    expect(refused.body?.comments?.length).toBeGreaterThanOrEqual(2)
    expect(refused.body?.comments?.map((c: any) => c.index)).toContain(0)
    expect(refused.body?.comments?.map((c: any) => c.index)).toContain(1)
  })

  test('still accepts a review with no comments, which is the browser flow', async () => {
    if (!available)
      return

    // The existing path must keep working: the browser publishes drafts written
    // earlier and sends no `comments` at all.
    const submitted = await postJson('/api/repos/pulls/reviews', created.reviewerToken, {
      number: '2',
      state: 'commented',
      body: 'just a note',
    })

    expect(submitted.status).toBe(201)
    expect(submitted.body?.comments).toEqual([])
  })

  test('refuses a comment review that says nothing at all', async () => {
    if (!available)
      return

    const refused = await postJson('/api/repos/pulls/reviews', created.reviewerToken, {
      number: '2',
      state: 'commented',
      body: '',
      comments: [],
    })

    expect(refused.status).toBe(422)
  })
})
