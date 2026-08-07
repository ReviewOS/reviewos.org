// Reviewer suggestions, from real git history to a ranked list.
//
// The ranking is unit tested over values. What that cannot cover is the two
// joins between git and this forge: reading history for the *changed paths
// only*, and matching the email in a commit to an account here. Either one
// failing returns an empty list, and an empty list is what a repository with no
// relevant history returns - so nothing looks wrong.
//
// Like the rest of tests/e2e it needs a database and git, and skips itself
// loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  authorId: 0,
  expertId: 0,
  strangerId: 0,
  repositoryId: 0,
  handle: '',
  expertHandle: '',
  strangerHandle: '',
  name: '',
  diskPath: '',
  temp: '',
  pullRequestId: 0,
}

let available = false

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Commit as a specific person, which is the whole point of the fixture. */
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

async function suggestions(): Promise<any[]> {
  const Suggest = (await import('../../app/Actions/Pull/SuggestReviewersAction')).default

  const answer: any = await Suggest.handle({
    get: (key: string) => ({
      owner: created.handle,
      repo: created.name,
      number: 1,
    } as Record<string, unknown>)[key],
    user: async () => ({ id: created.authorId }),
    headers: { get: () => null },
  })

  const body = await answer.json()
  return body?.suggestions ?? []
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-suggest-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    const make = async (prefix: string): Promise<{ id: number, handle: string, email: string }> => {
      const handle = unique(prefix)
      const email = `${handle}@example.com`
      const row: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Contributor', email, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle, email }
    }

    const author = await make('sga')
    const expert = await make('sge')
    const stranger = await make('sgs')

    created.authorId = author.id
    created.handle = author.handle
    created.expertId = expert.id
    created.expertHandle = expert.handle
    created.strangerId = stranger.id
    created.strangerHandle = stranger.handle

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: created.name,
        description: 'created by the suggested reviewers end to end test',
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
    writeFileSync(join(work, 'elsewhere.ts'), 'export const b = 0\n')
    await git(work, null, 'add', '.')
    await git(work, null, 'commit', '-m', 'the base')

    // The expert works on the file the pull request will change.
    for (let round = 1; round <= 3; round += 1) {
      writeFileSync(join(work, 'touched.ts'), `export const a = ${round}\n`)
      await git(work, expert, 'add', '.')
      await git(work, expert, 'commit', '-m', `expert round ${round}`)
    }

    // The stranger is busier, but only in a file nobody is changing. A
    // suggester that reads the whole repository rather than the changed paths
    // names them, and this is what catches that.
    for (let round = 1; round <= 8; round += 1) {
      writeFileSync(join(work, 'elsewhere.ts'), `export const b = ${round}\n`)
      await git(work, stranger, 'add', '.')
      await git(work, stranger, 'commit', '-m', `stranger round ${round}`)
    }

    await git(work, null, 'push', created.diskPath, 'main')
    const baseSha = await git(work, null, 'rev-parse', 'HEAD')

    await git(work, null, 'checkout', '-b', 'change')
    writeFileSync(join(work, 'touched.ts'), 'export const a = 99\n')
    await git(work, author, 'add', '.')
    await git(work, author, 'commit', '-m', 'change the touched file')
    const headSha = await git(work, null, 'rev-parse', 'HEAD')
    await git(work, null, 'push', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Change the touched file',
        body: 'Opened by the suggested reviewers end to end test.',
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
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    available = true
  }
  catch (error) {
    console.warn(`[suggest-reviewers] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    if (created.pullRequestId) {
      await db.deleteFrom('pull_request_reviewers').where('pull_request_id', '=', created.pullRequestId).execute()
      await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
    }

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    for (const id of [created.authorId, created.expertId, created.strangerId].filter(Boolean))
      await db.deleteFrom('users').where('id', '=', id).execute()
  }
  finally {
    if (created.diskPath)
      rmSync(created.diskPath, { recursive: true, force: true })
    if (created.temp)
      rmSync(created.temp, { recursive: true, force: true })
  }
})

describe('suggested reviewers', () => {
  test('names whoever has worked on the file being changed', async () => {
    if (!available)
      return

    expect((await suggestions()).map(one => one.handle)).toContain(created.expertHandle)
  })

  /**
   * The check that this reads history for the *changed paths* rather than for
   * the repository. The stranger has nearly three times the commits and none of
   * them are in the file anybody is changing; a suggester that named them would
   * name the most prolific committer for every pull request, which is a
   * suggestion nobody reads twice.
   */
  test('ignores somebody busy in a file nobody is changing', async () => {
    if (!available)
      return

    expect((await suggestions()).map(one => one.handle)).not.toContain(created.strangerHandle)
  })

  test('never suggests the author of the pull request', async () => {
    if (!available)
      return

    expect((await suggestions()).map(one => one.handle)).not.toContain(created.handle)
  })

  test('says why, with the commit count it actually counted', async () => {
    if (!available)
      return

    const found = (await suggestions()).find(one => one.handle === created.expertHandle)

    expect(found?.reason).toContain('3 commits here')
  })

  /**
   * Somebody already on the list is not a suggestion. Offering a name the
   * person just added makes the feature look broken to the one person watching
   * it closely.
   */
  test('drops somebody once they have been asked', async () => {
    if (!available)
      return

    await (globalThis as any).db.insertInto('pull_request_reviewers').values({
      pull_request_id: created.pullRequestId,
      reviewer_type: 'user',
      reviewer_id: created.expertId,
      from_code_owners: false,
    }).execute()

    expect((await suggestions()).map(one => one.handle)).not.toContain(created.expertHandle)
  })
})
