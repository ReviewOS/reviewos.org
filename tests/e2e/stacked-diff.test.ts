// A three-deep stack, and the claim the whole workflow rests on.
//
// The point of stacking is that each piece is reviewed on its own. If the
// middle pull request's diff showed its parent's changes too, the reviewer
// would read the same code twice and the stack would be worse than one large
// branch rather than better - so "shows only its own changes" is not a detail,
// it is the feature.
//
// It is also the claim most likely to be true by accident and then quietly stop
// being true, because it falls out of the base being the parent's branch rather
// than from anything that says so. Nothing in the code asserts it. This does.
//
// Like the rest of tests/e2e it needs a database and git, and skips itself
// loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  userId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  /** The three pull requests, bottom first. */
  ids: [] as number[],
  shas: {} as Record<string, string>,
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

/** The paths a pull request's own diff touches, through the real diff path. */
async function pathsInDiff(base: string, head: string): Promise<string[]> {
  const { streamMergeBaseDiff } = await import('../../app/Actions/Git/diffStream')
  const { parseDiff } = await import('../../app/Actions/Pull/diff')

  const diff = await streamMergeBaseDiff(created.diskPath, base, head)
  if (!diff)
    return []

  let patch = ''
  for await (const chunk of diff.chunks)
    patch += chunk

  return parseDiff(patch).map(file => file.path).sort()
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-stack-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('stk')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({
        name: 'Stack Author',
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
        description: 'created by the stacked diff end to end test',
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
    writeFileSync(join(work, 'base.ts'), 'export const base = 1\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')
    created.shas.main = await git(work, 'rev-parse', 'HEAD')

    // Three branches, each built on the one before, each adding one file. The
    // files are what make the claim checkable: the middle pull request must
    // show `two.ts` and nothing else.
    const chain = [
      { branch: 'one', file: 'one.ts' },
      { branch: 'two', file: 'two.ts' },
      { branch: 'three', file: 'three.ts' },
    ]

    for (const [index, step] of chain.entries()) {
      await git(work, 'checkout', '-b', step.branch)
      writeFileSync(join(work, step.file), `export const ${step.branch} = ${index + 1}\n`)
      await git(work, 'add', '.')
      await git(work, 'commit', '-m', `add ${step.file}`)
      created.shas[step.branch] = await git(work, 'rev-parse', 'HEAD')
      await git(work, 'push', created.diskPath, step.branch)
    }

    await git(work, 'push', created.diskPath, 'main')

    // Opened bottom first through the real action, so the stack link is made
    // the way the product makes it rather than written in by the fixture. That
    // is the point: the link is detected from the base branch, and a test that
    // set `stack_parent_id` by hand would prove nothing about the detection.
    const OpenPullRequest = (await import('../../app/Actions/Pull/OpenPullRequestAction')).default

    const bases = ['main', 'one', 'two']
    for (const [index, step] of chain.entries()) {
      const answer: any = await OpenPullRequest.handle(fakeRequest({
        owner: created.handle,
        repo: created.name,
        head: step.branch,
        base: bases[index]!,
        title: `Part ${index + 1}`,
      }))

      const body = await answer.json()
      if (!body?.number)
        throw new Error(`opening part ${index + 1} failed: ${JSON.stringify(body)}`)

      const row: any = await (globalThis as any).db
        .selectFrom('pull_requests')
        .select(['id'])
        .where('repository_id', '=', created.repositoryId)
        .where('number', '=', Number(body.number))
        .executeTakeFirst()

      created.ids.push(Number(row?.id))
    }

    available = true
  }
  catch (error) {
    console.warn(`[stacked-diff] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

/**
 * The shape an Action's handler reads, with the user already resolved.
 *
 * The action calls `authorizeRepository`, which calls `currentUser`, which asks
 * `request.user()`. Answering it directly is how this test signs in without a
 * socket, a token or a cookie - none of which are what it is about.
 */
function fakeRequest(values: Record<string, unknown>): any {
  return {
    get: (key: string) => values[key],
    user: async () => ({ id: created.userId }),
    headers: { get: () => null },
  }
}

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    for (const id of created.ids.filter(Boolean))
      await db.deleteFrom('pull_requests').where('id', '=', id).execute()

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  finally {
    if (created.diskPath)
      rmSync(created.diskPath, { recursive: true, force: true })
    if (created.temp)
      rmSync(created.temp, { recursive: true, force: true })
  }
})

describe('a three-deep stack', () => {
  test('each pull request is linked to the one below it', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'stack_parent_id', 'base_branch'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('number', 'asc')
      .execute()

    expect(rows).toHaveLength(3)
    // The bottom stands on the default branch and depends on nothing.
    expect(rows[0].stack_parent_id).toBeNull()
    expect(Number(rows[1].stack_parent_id)).toBe(created.ids[0])
    expect(Number(rows[2].stack_parent_id)).toBe(created.ids[1])
  })

  /**
   * The claim the workflow rests on. A middle pull request that showed its
   * parent's changes too would make the reviewer read the same code twice, and
   * a stack would be worse than one large branch rather than better.
   */
  test('the middle one shows only its own changes', async () => {
    if (!available)
      return

    expect(await pathsInDiff(created.shas.one!, created.shas.two!)).toEqual(['two.ts'])
  })

  test('the top one shows only its own changes', async () => {
    if (!available)
      return

    expect(await pathsInDiff(created.shas.two!, created.shas.three!)).toEqual(['three.ts'])
  })

  /**
   * The comparison that says the test above is measuring something. Diffed
   * against the default branch instead of its parent, the top pull request
   * carries all three files - which is exactly what a reviewer must not be
   * shown, and what they would be shown if the base were ever set to the
   * default branch by mistake.
   */
  test('against the default branch it would carry the whole stack', async () => {
    if (!available)
      return

    expect(await pathsInDiff(created.shas.main!, created.shas.three!))
      .toEqual(['one.ts', 'three.ts', 'two.ts'])
  })
})
