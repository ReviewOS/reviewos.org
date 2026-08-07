// CODEOWNERS, from a file on disk to a row in `pull_request_reviewers`.
//
// The matching rules are unit tested. What they cannot cover is the wiring, and
// the wiring is where this silently does nothing: a `CODEOWNERS` read from the
// wrong ref, a handle compared with the wrong case, or an insert that never
// happens all produce a pull request with no reviewers - which is exactly what
// a repository without a CODEOWNERS file produces, so nothing looks wrong.
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
  ownerId: 0,
  otherId: 0,
  memberId: 0,
  memberHandle: '',
  orgId: 0,
  orgHandle: '',
  teamId: 0,
  repositoryId: 0,
  handle: '',
  ownerHandle: '',
  otherHandle: '',
  name: '',
  diskPath: '',
  temp: '',
  pullRequestIds: [] as number[],
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

/** The shape an Action's handler reads, with the author already signed in. */
function fakeRequest(values: Record<string, unknown>): any {
  return {
    get: (key: string) => values[key],
    user: async () => ({ id: created.authorId }),
    headers: { get: () => null },
  }
}

/** Open a pull request from `branch`, and report who ended up asked. */
async function open(branch: string, title: string): Promise<{ id: number, asked: string[] }> {
  const OpenPullRequest = (await import('../../app/Actions/Pull/OpenPullRequestAction')).default

  const answer: any = await OpenPullRequest.handle(fakeRequest({
    owner: created.handle,
    repo: created.name,
    head: branch,
    base: 'main',
    title,
  }))

  const body = await answer.json()
  if (!body?.id)
    throw new Error(`opening ${branch} failed: ${JSON.stringify(body)}`)

  created.pullRequestIds.push(Number(body.id))

  const rows: any[] = await (globalThis as any).db
    .selectFrom('pull_request_reviewers')
    .leftJoin('users', 'users.id', '=', 'pull_request_reviewers.reviewer_id')
    .select(['users.handle as handle', 'pull_request_reviewers.from_code_owners as from_code_owners'])
    .where('pull_request_reviewers.pull_request_id', '=', Number(body.id))
    .execute()

  return { id: Number(body.id), asked: rows.map(row => String(row.handle)).sort() }
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-owners-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    const make = async (prefix: string): Promise<{ id: number, handle: string }> => {
      const handle = unique(prefix)
      const row: any = await (globalThis as any).db
        .insertInto('users')
        .values({ name: 'Owner', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle }
    }

    const author = await make('coa')
    const owner = await make('cow')
    const other = await make('coo')

    created.authorId = author.id
    created.handle = author.handle
    created.ownerId = owner.id
    created.ownerHandle = owner.handle
    created.otherId = other.id
    created.otherHandle = other.handle

    // An organization with a team on it, holding one fresh member and the
    // author. The team is what the file names; the people are who get asked.
    const member = await make('com')
    created.memberId = member.id
    created.memberHandle = member.handle

    created.orgHandle = unique('coorg')
    const org: any = await (globalThis as any).db
      .insertInto('organizations')
      .values({ handle: created.orgHandle, name: 'Codeowners Org' })
      .returning(['id'])
      .executeTakeFirst()
    created.orgId = Number(org?.id)

    const team: any = await (globalThis as any).db
      .insertInto('teams')
      .values({ organization_id: created.orgId, name: 'Reviewers', slug: 'reviewers' })
      .returning(['id'])
      .executeTakeFirst()
    created.teamId = Number(team?.id)

    for (const userId of [created.memberId, created.authorId]) {
      await (globalThis as any).db
        .insertInto('team_members')
        .values({ team_id: created.teamId, user_id: userId, role: 'member' })
        .execute()
    }

    created.name = unique('repo')
    const resolvedPath = repositoryPath(created.handle, created.name)
    created.diskPath = resolvedPath.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.authorId,
        name: created.name,
        description: 'created by the codeowners end to end test',
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

    mkdirSync(join(work, 'docs'))
    mkdirSync(join(work, 'src'))
    mkdirSync(join(work, 'team'))
    writeFileSync(join(work, 'docs', 'guide.md'), '# Guide\n')
    writeFileSync(join(work, 'src', 'app.ts'), 'export const app = 1\n')
    writeFileSync(join(work, 'team', 'notes.ts'), 'export const notes = 1\n')
    writeFileSync(join(work, 'README.md'), '# Read me\n')

    // The author owns the source; somebody else owns the docs. That split is
    // what lets the tests tell "asked the right person" from "asked everyone".
    //
    // `*.md` comes *first* on purpose, and writing it last is the mistake this
    // file's unit tests warn about: the last matching rule wins, so a catch-all
    // at the bottom would take `docs/guide.md` away from the docs owner and
    // hand it to a team that is not a user here. The fixture was written the
    // wrong way round the first time, which is the whole argument for reading
    // the rule exactly rather than the way it feels like it should work.
    writeFileSync(join(work, 'CODEOWNERS'), [
      '# a team and a stranger, neither of whom is a user here',
      `*.md @acme/writers @nobody-${unique('x')}`,
      `src/ @${created.handle}`,
      `docs/ @${created.ownerHandle}`,
      `team/ @${created.orgHandle}/reviewers`,
      '',
    ].join('\n'))

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'the base, with owners')
    await git(work, 'push', created.diskPath, 'main')

    // One branch per case, all off the same base.
    const branches: Array<[string, string, string]> = [
      ['touch-docs', join('docs', 'guide.md'), '# Guide, revised\n'],
      ['touch-src', join('src', 'app.ts'), 'export const app = 2\n'],
      ['touch-readme', 'README.md', '# Read me, revised\n'],
      ['touch-team', join('team', 'notes.ts'), 'export const notes = 2\n'],
    ]

    for (const [branch, file, contents] of branches) {
      await git(work, 'checkout', 'main')
      await git(work, 'checkout', '-b', branch)
      writeFileSync(join(work, file), contents)
      await git(work, 'add', '.')
      await git(work, 'commit', '-m', `change ${file}`)
      await git(work, 'push', created.diskPath, branch)
    }

    available = true
  }
  catch (error) {
    console.warn(`[codeowners] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  try {
    const db = (globalThis as any).db
    if (!db)
      return

    for (const id of created.pullRequestIds) {
      await db.deleteFrom('pull_request_reviewers').where('pull_request_id', '=', id).execute()
      await db.deleteFrom('pull_requests').where('id', '=', id).execute()
    }

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.teamId) {
      await db.deleteFrom('team_members').where('team_id', '=', created.teamId).execute()
      await db.deleteFrom('teams').where('id', '=', created.teamId).execute()
    }

    if (created.orgId)
      await db.deleteFrom('organizations').where('id', '=', created.orgId).execute()

    for (const id of [created.authorId, created.ownerId, created.otherId, created.memberId].filter(Boolean))
      await db.deleteFrom('users').where('id', '=', id).execute()
  }
  finally {
    if (created.diskPath)
      rmSync(created.diskPath, { recursive: true, force: true })
    if (created.temp)
      rmSync(created.temp, { recursive: true, force: true })
  }
})

describe('CODEOWNERS on open', () => {
  test('asks the owner of the files the branch touches', async () => {
    if (!available)
      return

    const { asked } = await open('touch-docs', 'Revise the guide')

    expect(asked).toEqual([created.ownerHandle])
  })

  /**
   * "Who was asked, and did they reply" has to read the same whether a person
   * or a file did the asking, which is why the request is a row here rather
   * than something inferred. The flag is how the interface can say which.
   */
  test('records that the file asked, not a person', async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('pull_request_reviewers')
      .select(['from_code_owners'])
      .where('pull_request_id', '=', created.pullRequestIds[0]!)
      .executeTakeFirst()

    expect(Boolean(row?.from_code_owners)).toBe(true)
  })

  /**
   * Being named as the owner of a file you are changing is the normal case, not
   * an exception. A forge that asked you to review your own pull request would
   * put a request in your own queue for every change you make.
   */
  test('never asks the author to review their own change', async () => {
    if (!available)
      return

    const { asked } = await open('touch-src', 'Change the app')

    expect(asked).toEqual([])
  })

  /**
   * The file is checked in and can name anyone: a team, an email address,
   * somebody who has left. None of those is a reason to refuse to open a pull
   * request, which would make a stale line in a text file look like the forge
   * being broken.
   */
  /**
   * A team is the file naming a group, and the group is people. The author is
   * on this team, and is still not asked: being named indirectly is still
   * being named, and a request in your own queue for your own change is wrong
   * however it got there.
   */
  test('a team resolves to its members, minus the author', async () => {
    if (!available)
      return

    const { asked } = await open('touch-team', 'Change the team notes')

    expect(asked).toEqual([created.memberHandle])
  })

  test('a name that matches nobody here is skipped, not an error', async () => {
    if (!available)
      return

    const { id, asked } = await open('touch-readme', 'Revise the readme')

    expect(id).toBeGreaterThan(0)
    expect(asked).toEqual([])
  })
})
