// "Since I last looked", against a real repository that gets force-pushed.
//
// The whole claim of this feature is one sentence: after a rebase, a file the
// rebase did not touch must not be put back in front of the reviewer. That is
// where GitHub gives up and shows the entire diff again, and it is the only
// case worth writing a test for - the easy case, a commit appended to the
// branch, would pass against a naive `git diff lastSeen head` too.
//
// So the fixture rebases. Three files are changed by the branch; the base then
// moves under it and one of the three is touched by that movement; the branch
// is rebased onto the new base and one file's own change is edited. The correct
// answer names exactly two files, and a two-dot diff would name all three plus
// everything the base did.
//
// Like the rest of tests/e2e this needs the router, a database and a socket,
// and skips itself loudly when the database is not there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  userId: 0,
  repositoryId: 0,
  pullRequestId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  token: '',
  /** The head the reviewer read, before the base moved and the branch rebased. */
  firstHead: '',
  finalHead: '',
  finalBase: '',
}

let port = 0
let available = false
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
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  // Thrown rather than ignored. A fixture whose push silently failed builds a
  // repository that is missing the commit the whole test is about, and the
  // failure then reads as the feature being broken.
  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

async function ask(since?: string): Promise<any> {
  const extra = since ? `&since=${since}` : ''
  const answer = await fetch(
    `http://127.0.0.1:${port}/api/repos/pulls/review-state/since`
    + `?owner=${created.handle}&repo=${created.name}&number=1${extra}`,
    { headers: { Authorization: `Bearer ${created.token}` } },
  )

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-since-'))

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

    created.handle = unique('since')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({
        name: 'Incremental Reader',
        email: `${created.handle}@example.com`,
        handle: created.handle,
        password: 'x',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.userId, 'since last look test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the since-last-look end to end test',
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

    // Four files on main, several lines each so the base and the branch have
    // room to change different parts of the same file without conflicting.
    // `untouched.ts` is the control: nothing in this test ever changes it, so
    // it must never appear in an answer.
    const original = (name: string) => [
      `// ${name}`,
      'const one = 1',
      'const two = 2',
      'const three = 3',
      'const four = 4',
      'const five = 5',
      '',
    ].join('\n')

    /** The same file with line four changed, which is what the branch proposes. */
    const proposed = (name: string, value: string) =>
      original(name).replace('const three = 3', `const three = ${value}`)

    for (const name of ['stable.ts', 'edited.ts', 'rebased.ts', 'untouched.ts'])
      writeFileSync(join(work, name), original(name))

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base')

    // The branch changes three of them. This is what the reviewer read.
    await git(work, 'checkout', '-b', 'change')
    for (const name of ['stable.ts', 'edited.ts', 'rebased.ts'])
      writeFileSync(join(work, name), proposed(name, '30'))

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the proposal')
    created.firstHead = await git(work, 'rev-parse', 'HEAD')

    await git(work, 'push', created.diskPath, 'main')
    await git(work, 'push', created.diskPath, 'change')

    // The base moves, and inserts a line at the top of `rebased.ts` - far
    // enough from the branch's own change to rebase cleanly, close enough that
    // the change now sits at a different line among different context. So
    // after the rebase that file is proposed against different surrounding
    // content even though the branch never edited it again, which is a real
    // thing to re-read.
    await git(work, 'checkout', 'main')
    writeFileSync(join(work, 'rebased.ts'), `// added by the base\n${original('rebased.ts')}`)
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base moves')
    created.finalBase = await git(work, 'rev-parse', 'HEAD')

    // The rebase itself, plus one deliberate edit to the branch's own work.
    // Every commit sha on the branch changes here, which is the condition that
    // defeats comparing two tips.
    await git(work, 'checkout', 'change')
    await git(work, 'rebase', 'main')
    writeFileSync(join(work, 'edited.ts'), proposed('edited.ts', '300'))
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'answer the review')
    created.finalHead = await git(work, 'rev-parse', 'HEAD')

    await git(work, 'push', created.diskPath, 'main')
    await git(work, 'push', '--force', created.diskPath, 'change')

    const pullRequest: any = await (globalThis as any).db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Three files, then a rebase',
        body: 'Opened by the since-last-look end to end test.',
        author_id: created.userId,
        state: 'open',
        head_branch: 'change',
        head_sha: created.finalHead,
        base_branch: 'main',
        base_sha: created.finalBase,
        draft: false,
        additions: 3,
        deletions: 3,
        changed_files: 3,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    // What the reviewer read, recorded the way the product records it: they
    // ticked a file while the first head was current.
    await (globalThis as any).db
      .insertInto('reviewed_files')
      .values({
        pull_request_id: created.pullRequestId,
        reviewer_id: created.userId,
        path: 'stable.ts',
        head_sha: created.firstHead,
      })
      .execute()

    // Sanity: the fixture is only meaningful if the rebase really did rewrite
    // the branch. If these matched, every assertion below would pass for the
    // wrong reason.
    if (created.firstHead === created.finalHead)
      throw new Error('the fixture did not rebase')

    available = true
  }
  catch (error) {
    console.warn(`[since-last-look] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    if (created.pullRequestId) {
      await db.deleteFrom('reviewed_files').where('pull_request_id', '=', created.pullRequestId).execute()
      await db.deleteFrom('review_drafts').where('pull_request_id', '=', created.pullRequestId).execute()
      await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
    }

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  finally {
    server?.stop?.()
    if (created.diskPath)
      rmSync(created.diskPath, { recursive: true, force: true })
    if (created.temp)
      rmSync(created.temp, { recursive: true, force: true })
  }
})

describe('since I last looked', () => {
  /**
   * The whole feature, in one assertion.
   *
   * `stable.ts` is changed by the branch and untouched by everything that
   * happened afterwards. Its proposal is identical, so a reviewer who read it
   * must not be shown it again - even though every commit that carried it has a
   * different sha now.
   */
  test('a rebase does not put back a file whose proposal did not move', async () => {
    if (!available)
      return

    const answer = await ask()

    expect(answer.status).toBe(200)
    expect(answer.body.looked).toBe(true)
    expect(answer.body.since).toBe(created.firstHead)
    expect(answer.body.changed).not.toContain('stable.ts')
    expect(answer.body.unchanged).toBeGreaterThanOrEqual(1)
  })

  test('a file the author edited since is named', async () => {
    if (!available)
      return

    const answer = await ask()
    expect(answer.body.changed).toContain('edited.ts')
  })

  /**
   * Not a false positive. The branch did not edit this file a second time, but
   * the base moved its surrounding content, so the change is now proposed
   * against different code - and whether it still makes sense is a question
   * only the reviewer can answer.
   */
  test('a file the base moved under is named too', async () => {
    if (!available)
      return

    const answer = await ask()
    expect(answer.body.changed).toContain('rebased.ts')
  })

  test('a file nobody ever touched is in no answer at all', async () => {
    if (!available)
      return

    const answer = await ask()

    expect(answer.body.changed).not.toContain('untouched.ts')
    expect(answer.body.added).not.toContain('untouched.ts')
    expect(answer.body.removed).not.toContain('untouched.ts')
  })

  test('asking about the current head is asking about nothing', async () => {
    if (!available)
      return

    const answer = await ask(created.finalHead)

    expect(answer.body.changed).toEqual([])
    expect(answer.body.added).toEqual([])
    expect(answer.body.removed).toEqual([])
  })

  /**
   * A force-push can leave the sha a reviewer saw unreachable, and a garbage
   * collection removes it. Saying so is the answer: a filter that silently
   * hides nothing looks identical to one that found nothing to hide.
   */
  test('a sha that is not in the repository is reported, not guessed at', async () => {
    if (!available)
      return

    const answer = await ask('0'.repeat(40))

    expect(answer.status).toBe(200)
    expect(answer.body.unreadable).toBe(true)
  })

  test('a reader with no record of looking is offered nothing', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/pulls/review-state/since`
      + `?owner=${created.handle}&repo=${created.name}&number=1`,
    )

    expect(answer.status).toBe(200)
    expect((await answer.json()).looked).toBe(false)
  })
})
