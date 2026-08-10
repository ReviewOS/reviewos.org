// A tick that has stopped being true, through the real route.
//
// The assertion the whole feature hangs on is the one a naive implementation
// fails: two files are ticked at the same head, a push changes one of them, and
// **only that one** goes stale. Unmarking on any push is a one-line
// implementation that passes every test except this, and it is worse than
// nothing - a reviewer whose ticks all clear on every push learns to ignore
// them, which costs them the record of what they had read.
//
// The second one is the rebase: the base moves under the branch and every file
// is rewritten by git, but the file whose *proposal* did not change keeps its
// tick. That is the property the fingerprints exist for.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  reviewerId: 0,
  token: '',
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  pullRequestId: 0,
  firstHead: '',
  secondHead: '',
  baseSha: '',
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

async function stale(): Promise<{ status: number, body: any }> {
  const query = new URLSearchParams({
    owner: created.handle,
    repo: created.name,
    number: '1',
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/review-state/stale?${query}`, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${created.token}` },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Tick a file at whatever head the pull request is on now. */
async function tick(path: string): Promise<void> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/review-state/viewed`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${created.token}`,
    },
    body: new URLSearchParams({
      owner: created.handle,
      repo: created.name,
      number: '1',
      path,
      viewed: '1',
    }),
  })

  if (!answer.ok)
    throw new Error(`ticking ${path} answered ${answer.status}`)
}

/** Move the branch on, the way a push does. */
async function setHead(sha: string): Promise<void> {
  await (globalThis as any).db
    .updateTable('pull_requests')
    .set({ head_sha: sha })
    .where('id', '=', created.pullRequestId)
    .execute()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-stale-'))

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

    created.handle = unique('stk')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Stale Ticks', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.reviewerId = Number(user?.id)
    const issued: any = await createToken(created.reviewerId, 'stale ticks test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.reviewerId,
        name: created.name,
        description: 'created by the stale ticks end to end test',
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
    writeFileSync(join(work, 'untouched.ts'), 'export const untouched = 0\n')
    writeFileSync(join(work, 'moves.ts'), 'export const moves = 0\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // The branch proposes a change to both files. This is what the reviewer
    // reads and ticks.
    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'untouched.ts'), 'export const untouched = 1\n')
    writeFileSync(join(work, 'moves.ts'), 'export const moves = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'change both files')
    created.firstHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    // A second round, touching one of them.
    writeFileSync(join(work, 'moves.ts'), 'export const moves = 2\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'and move one of them again')
    created.secondHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Stale ticks fixture',
        body: '',
        author_id: created.reviewerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.firstHead,
        base_branch: 'main',
        base_sha: created.baseSha,
        draft: false,
        additions: 2,
        deletions: 2,
        changed_files: 2,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    available = true
  }
  catch (error) {
    console.warn(`[stale-ticks] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.reviewerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.reviewerId).execute()
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

describe('a tick that has stopped being true', () => {
  test('nothing is stale while the reader is on the head they read', async () => {
    if (!available)
      return

    await tick('untouched.ts')
    await tick('moves.ts')

    const { status, body } = await stale()

    expect(status).toBe(200)
    expect(body?.stale ?? []).toEqual([])
    expect(body?.unverifiable ?? []).toEqual([])
  }, 30_000)

  /**
   * The assertion the feature exists for, and the one an implementation that
   * unmarks on every push fails.
   */
  test('a push marks the file it changed, and only that one', async () => {
    if (!available)
      return

    await setHead(created.secondHead)

    const { status, body } = await stale()

    expect(status).toBe(200)
    expect(body?.stale ?? []).toEqual(['moves.ts'])
    // The one the second round did not touch keeps its tick, which is the whole
    // point: the head moved for both files and only one of them changed.
    expect(body?.stale ?? []).not.toContain('untouched.ts')
    expect(body?.unverifiable ?? []).toEqual([])
  }, 30_000)

  test('re-reading it clears the mark, because the tick is recorded at the new head', async () => {
    if (!available)
      return

    await tick('moves.ts')

    const { body } = await stale()

    expect(body?.stale ?? []).toEqual([])
  }, 30_000)

  /**
   * The rebase, which is where a two-dot comparison gives up.
   *
   * The base moves under the branch, every commit is rewritten, and git will
   * happily report both files as different between the two heads. What has not
   * changed is what either file *proposes*, and that is what the tick was about.
   */
  test('a rebase rewrites both files and neither tick goes stale', async () => {
    if (!available)
      return

    await tick('untouched.ts')
    await tick('moves.ts')

    const work = join(created.temp, 'seed')

    // Somebody else lands something on the base branch.
    await git(work, 'checkout', 'main')
    writeFileSync(join(work, 'elsewhere.ts'), 'export const elsewhere = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'a change from somebody else')
    const movedBase = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    // And the branch is rebased onto it, which rewrites every commit on it.
    await git(work, 'checkout', 'change')
    await git(work, 'rebase', 'main')
    const rebased = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', '--force', created.diskPath, 'change')

    expect(rebased).not.toBe(created.secondHead)

    await (globalThis as any).db
      .updateTable('pull_requests')
      .set({ head_sha: rebased, base_sha: movedBase })
      .where('id', '=', created.pullRequestId)
      .execute()

    const { body } = await stale()

    // Both files were rewritten by the rebase and neither proposes anything
    // different, so both ticks stand.
    expect(body?.stale ?? []).toEqual([])
    expect(body?.unverifiable ?? []).toEqual([])
  }, 60_000)

  /**
   * The force-push case. The commit the tick was made at is unreachable, so
   * nothing can be compared against it - and "unchanged" would be the interface
   * claiming somebody has read something nobody can confirm they read.
   */
  test('a tick made at a commit that is gone is unverifiable rather than fine', async () => {
    if (!available)
      return

    await (globalThis as any).db
      .updateTable('reviewed_files')
      .set({ head_sha: '0000000000000000000000000000000000000001' })
      .where('pull_request_id', '=', created.pullRequestId)
      .where('path', '=', 'untouched.ts')
      .execute()

    const { body } = await stale()

    expect(body?.unverifiable ?? []).toEqual(['untouched.ts'])
    expect(body?.stale ?? []).toEqual([])
  }, 30_000)
})
