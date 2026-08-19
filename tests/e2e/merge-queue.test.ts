// The merge queue against a real repository.
//
// The unit tests hold the ordering rules. This holds the thing only git can be
// wrong about: that the commit a run is given is the *prospective merge result*
// - the base with everything ahead already merged, plus this one - and that
// landing it moves the branch to the commit that was tested rather than merging
// again, which would produce a different commit from the one that went green.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { enqueue, queueFor, settleEntry, startNext } from '../../app/Actions/Pull/mergeQueue'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  baseSha: '',
  first: { id: 0, sha: '', number: 1 },
  second: { id: 0, sha: '', number: 2 },
  third: { id: 0, sha: '', number: 3 },
}

let available = false
let db: any = null

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

/** The bare repository's view of a ref. */
async function shaOf(ref: string): Promise<string> {
  const { runGit } = await import('../../app/Actions/Git/git')
  const result = await runGit(created.diskPath, ['rev-parse', '--verify', ref])

  return result.code === 0 ? result.stdout.trim() : ''
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-merge-queue-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('mq')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Queue Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
    writeFileSync(join(work, 'app.ts'), 'export const one = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    created.baseSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'main')

    /*
     * Two branches that touch different files, so both merge cleanly onto the
     * base and onto each other. Whether they *work* together is what a run
     * would answer; the queue's job is to give the run the commit where both
     * exist.
     */
    await git(work, 'checkout', '-b', 'first')
    writeFileSync(join(work, 'first.ts'), 'export const first = true\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'add first')
    created.first.sha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'first')

    await git(work, 'checkout', 'main')
    await git(work, 'checkout', '-b', 'third')
    writeFileSync(join(work, 'third.ts'), 'export const third = true\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'add third')
    created.third.sha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'third')

    await git(work, 'checkout', 'main')
    await git(work, 'checkout', '-b', 'second')
    writeFileSync(join(work, 'second.ts'), 'export const second = true\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'add second')
    created.second.sha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', created.diskPath, 'second')

    for (const [key, branch] of [['first', 'first'], ['second', 'second'], ['third', 'third']] as Array<[keyof typeof created, string]>) {
      const entry = created[key] as { id: number, sha: string, number: number }

      const pull: any = await db
        .insertInto('pull_requests')
        .values({
          repository_id: created.repositoryId,
          number: entry.number,
          title: `Add ${branch}`,
          body: '',
          author_id: created.ownerId,
          state: 'open',
          head_branch: branch,
          head_sha: entry.sha,
          base_branch: 'main',
          base_sha: created.baseSha,
          draft: false,
          additions: 1,
          deletions: 0,
          changed_files: 1,
        })
        .returning(['id'])
        .executeTakeFirst()

      entry.id = Number(pull?.id)
    }

    available = true
  }
  catch (error) {
    console.warn(`[merge-queue] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  rmSync(created.temp, { recursive: true, force: true })
  removeRepositoryDirectory(created.diskPath)
})

describe('a queue of two', () => {
  test('the first is tested on a prospective commit, and the branch does not move', async () => {
    if (!available)
      return

    expect((await enqueue({ repositoryId: created.repositoryId, pullRequestId: created.first.id, baseBranch: 'main' })).ok).toBe(true)
    expect((await enqueue({ repositoryId: created.repositoryId, pullRequestId: created.second.id, baseBranch: 'main' })).ok).toBe(true)

    const started: any = await startNext({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      baseBranch: 'main',
    })

    expect(started.ok).toBe(true)
    expect(String(started.mergeSha)).toMatch(/^[0-9a-f]{40}$/)

    /*
     * The commit exists and carries the change, on a ref a runner can check
     * out - a prospective merge that exists only as an unreferenced object is
     * one git will collect while the run is still using it.
     */
    expect(await shaOf(started.ref)).toBe(started.mergeSha)

    const { runGit } = await import('../../app/Actions/Git/git')
    const listed = await runGit(created.diskPath, ['ls-tree', '--name-only', started.mergeSha])

    expect(listed.stdout).toContain('first.ts')

    // And `main` has not moved: nothing has been tested yet.
    expect(await shaOf('refs/heads/main')).toBe(created.baseSha)
  }, 180_000)

  test('and landing it moves the branch to exactly the commit that was tested', async () => {
    if (!available)
      return

    const [entry] = await queueFor(created.repositoryId, 'main')

    expect(entry.state).toBe('testing')

    const outcome = await settleEntry({
      entryId: entry.id,
      passed: true,
      ownerHandle: created.handle,
      repositoryName: created.name,
    })

    expect(outcome.merged).toBe(true)

    /*
     * The whole point. Merging again at this moment would produce a *different*
     * commit from the one the run went green on - same tree, different parents
     * or timestamp - and the thing that was tested would never exist.
     */
    expect(await shaOf('refs/heads/main')).toBe(entry.mergeSha)
  }, 180_000)

  test('the second is then tested on top of the first', async () => {
    if (!available)
      return

    const started: any = await startNext({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      baseBranch: 'main',
    })

    expect(started.ok).toBe(true)

    const { runGit } = await import('../../app/Actions/Git/git')
    const listed = await runGit(created.diskPath, ['ls-tree', '--name-only', started.mergeSha])

    // Both changes are in the commit the run will see, which is the answer
    // "green on my branch" cannot give.
    expect(listed.stdout).toContain('first.ts')
    expect(listed.stdout).toContain('second.ts')
  }, 180_000)

  test('and a failure ejects it with a reason, leaving the branch alone', async () => {
    if (!available)
      return

    const before = await shaOf('refs/heads/main')
    const testing = (await queueFor(created.repositoryId, 'main')).find(one => one.state === 'testing')!

    const outcome = await settleEntry({
      entryId: testing.id,
      passed: false,
      reason: 'The prospective merge failed its tests.',
      ownerHandle: created.handle,
      repositoryName: created.name,
    })

    expect(outcome.merged).toBe(false)
    expect(await shaOf('refs/heads/main')).toBe(before)

    const row: any = await db
      .selectFrom('merge_queue_entries')
      .select(['state', 'reason'])
      .where('id', '=', testing.id)
      .executeTakeFirst()

    // `ejected`, not `failed`: the pull request has not failed, it did not land
    // this time in this order - and saying so is the difference between a queue
    // people trust and one they route around.
    expect(String(row.state)).toBe('ejected')
    expect(String(row.reason)).toContain('failed its tests')
  }, 180_000)

  test('an ejected pull request can rejoin, behind whatever is waiting', async () => {
    if (!available)
      return

    /*
     * Somebody else's change joins while the ejected one is being fixed, and
     * the rejoin goes behind it: a change that already failed does not go
     * ahead of changes that have been waiting for it to get out of the way.
     */
    const waiting = await enqueue({
      repositoryId: created.repositoryId,
      pullRequestId: created.third.id,
      baseBranch: 'main',
    })

    const again = await enqueue({
      repositoryId: created.repositoryId,
      pullRequestId: created.second.id,
      baseBranch: 'main',
    })

    expect(again.ok).toBe(true)
    expect((again as any).position).toBeGreaterThan((waiting as any).position)
  }, 180_000)

  test('and the same pull request cannot be queued twice', async () => {
    if (!available)
      return

    /*
     * Two entries for one pull request would each be tested, and the second
     * would be testing a change the first already landed.
     */
    const twice = await enqueue({
      repositoryId: created.repositoryId,
      pullRequestId: created.second.id,
      baseBranch: 'main',
    })

    expect(twice.ok).toBe(false)
    expect((twice as any).status).toBe(409)
  }, 180_000)
})
