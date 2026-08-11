// `closes #123` in a pushed commit, end to end.
//
// The parsing has had unit tests since it was written, and the roadmap has
// said this works since phase 3 closed. What has never been asserted is the
// path between them: a real commit, pushed into a real bare repository, going
// through the job the hook dispatches, and an issue in the database actually
// changing state.
//
// That gap is the one worth closing here. Every piece can be individually
// correct while the whole does nothing - the job resolves the repository from
// the directory on disk, reads the commits git reports for the updated refs,
// and only then looks at the message, and any of those can quietly come back
// empty.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }
const issues: Record<string, number> = {}

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

/** One issue, open, in this repository. Returns its number. */
async function openIssue(number: number, title: string): Promise<number> {
  const row: any = await db
    .insertInto('issues')
    .values({
      repository_id: created.repositoryId,
      number,
      title,
      body: '',
      state: 'open',
      is_pull_request: false,
      author_id: created.ownerId,
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(row?.id)
}

async function stateOf(number: number): Promise<string | null> {
  const row: any = await db
    .selectFrom('issues')
    .select(['state'])
    .where('repository_id', '=', created.repositoryId)
    .where('number', '=', number)
    .executeTakeFirst()

  return row ? String(row.state) : null
}

/**
 * Push a commit carrying `message`, then run the job the post-receive hook
 * dispatches, with the same shape of payload `routes/git.ts` hands it.
 */
async function pushCommit(message: string, file: string): Promise<void> {
  const work = join(created.temp, 'work')
  writeFileSync(join(work, file), `${message}\n`)
  await git(work, 'add', '.')
  await git(work, 'commit', '-m', message)

  const before = await git(work, 'rev-parse', 'HEAD~1').catch(() => '0'.repeat(40))
  await git(work, 'push', created.diskPath, 'main')
  const after = await git(work, 'rev-parse', 'HEAD')

  // Built through the hook's own parser rather than by hand. A literal
  // `{ ref, before, after }` is missing `kind`, and `branchUpdates` filters on
  // it - so the job accepts the payload, finds no branches, reads no commits
  // and reports success having done nothing. Which is exactly what this test
  // did before, while appearing to pass on a close the repository's real
  // post-receive hook had raced it to.
  const { parseRefUpdates } = await import('../../app/Actions/Git/push')
  const updates = parseRefUpdates(`${before} ${after} refs/heads/main`)

  const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')
  const result: any = await ProcessPushJob.handle({ gitDir: created.diskPath, updates })

  if (result?.ok === false)
    throw new Error(`the push job did nothing: ${result.reason}`)
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-closes-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('clo')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Closes', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the commit-closes-issue end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'work')
    mkdirSync(work, { recursive: true })
    await git(work, 'init', '--initial-branch=main')
    writeFileSync(join(work, 'seed.txt'), 'first\n')
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the first commit, mentioning nothing')
    await git(work, 'push', created.diskPath, 'main')

    // One issue per case, so no test can pass on another's close.
    issues.closes = await openIssue(101, 'closed by the word closes')
    issues.fixes = await openIssue(102, 'closed by the word fixes')
    issues.resolved = await openIssue(103, 'closed by the word resolved')
    issues.mentioned = await openIssue(104, 'only mentioned, never closed')
    issues.quoted = await openIssue(105, 'named inside a code span')
    issues.cross = await openIssue(106, 'named by another repository')
    issues.multi1 = await openIssue(107, 'first of two in one message')
    issues.multi2 = await openIssue(108, 'second of two in one message')

    available = true
  }
  catch (error) {
    console.warn(`[closes] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId) {
      await db.deleteFrom('issues').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
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
})

describe('a pushed commit that says it closes an issue', () => {
  test('closes #101', async () => {
    if (!available)
      return

    expect(await stateOf(101)).toBe('open')
    await pushCommit('the thing is done, closes #101', 'a.txt')
    expect(await stateOf(101)).toBe('closed')
  })

  test('and the other spellings work too', async () => {
    if (!available)
      return

    await pushCommit('Fixes #102', 'b.txt')
    expect(await stateOf(102)).toBe('closed')

    // Past tense, and a colon, which the parser allows.
    await pushCommit('resolved: #103', 'c.txt')
    expect(await stateOf(103)).toBe('closed')
  })

  test('and one message can close two issues', async () => {
    if (!available)
      return

    await pushCommit('a bigger change, closes #107 and fixes #108', 'd.txt')
    expect(await stateOf(107)).toBe('closed')
    expect(await stateOf(108)).toBe('closed')
  })
})

describe('and a commit that does not say so leaves the issue alone', () => {
  test('a bare mention is a reference, not a close', async () => {
    if (!available)
      return

    await pushCommit('while looking at #104 I noticed something else', 'e.txt')
    expect(await stateOf(104)).toBe('open')

    // The other half of the promise: the issue should carry a line saying
    // which commit talked about it, or the mention was silently dropped.
    const issue: any = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', 104)
      .executeTakeFirst()

    const entries: any[] = await db
      .selectFrom('timeline_entries')
      .select(['kind'])
      .where('subject_id', '=', Number(issue.id))
      .where('kind', '=', 'referenced')
      .execute()

    expect(entries.length).toBeGreaterThan(0)
  })

  test('a keyword inside a code span does not count', async () => {
    if (!available)
      return

    await pushCommit('document that `closes #105` is the syntax', 'f.txt')
    expect(await stateOf(105)).toBe('open')
  })

  test('and a reference to another repository is not followed', async () => {
    if (!available)
      return

    // Permission here is not permission there. Closing an issue in a
    // repository the pusher may not even be able to read is not something a
    // push should be able to do quietly.
    await pushCommit('closes other-owner/other-repo#106', 'g.txt')
    expect(await stateOf(106)).toBe('open')
  })
})
