// Mergeability computed when the push lands, not when the first visitor asks.
//
// The view computes and caches the answer on demand; the item was only about
// when the cost is paid. So the assertion is on the cache: after the push
// job runs, the row already holds an answer keyed to the new head, and the
// page's own call would find it current. The job is exercised directly - the
// wire protocol that leads to it is git-http.test.ts's subject.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  repositoryId: 0,
  pullRequestId: 0,
  baseSha: '',
  oldHead: '',
  newHead: '',
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

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-bg-merge-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('bgm')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Background Merge', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(user?.id)

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the background mergeability end to end test',
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
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'first')
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    await git(work, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'second')
    created.oldHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Background mergeability fixture',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.oldHead,
        base_branch: 'main',
        base_sha: created.baseSha,
        draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        mergeable_state: 'unknown',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    // The branch moves again - the push this test is about.
    writeFileSync(join(work, 'c.txt'), 'c\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'third')
    created.newHead = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'change')

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

    if (created.ownerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.ownerId).execute()
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
})

describe('mergeability computed when the push lands', () => {
  test('the job leaves an answer the first visitor finds already cached', async () => {
    if (!available)
      return

    const ProcessPushJob = (await import('../../app/Jobs/ProcessPushJob')).default

    const result: any = await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: [{
        before: created.oldHead,
        after: created.newHead,
        ref: 'refs/heads/change',
        kind: 'branch',
        change: 'updated',
        name: 'change',
      }],
    })

    expect(result?.ok).toBe(true)
    expect(Number(result?.mergeabilityPrecomputed ?? 0)).toBe(1)

    const row: any = await (globalThis as any).db
      .selectFrom('pull_requests')
      .select(['head_sha', 'mergeable_state', 'mergeable_head_sha'])
      .where('id', '=', created.pullRequestId)
      .executeTakeFirst()

    // The cheap half brought the head up to date; the new half answered for
    // it. Keyed to the sha it answered for, which is what makes the page's
    // own call a cache hit.
    expect(String(row?.head_sha)).toBe(created.newHead)
    expect(String(row?.mergeable_state)).toBe('clean')
    expect(String(row?.mergeable_head_sha)).toBe(created.newHead)
  }, 60_000)
})
