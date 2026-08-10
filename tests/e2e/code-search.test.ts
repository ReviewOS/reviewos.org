// Code search, against a repository with real commits in it.
//
// The unit tests pin the arguments and the parsing. This is the half that only
// a real `git grep` can answer: that the ref is honoured, that a private
// repository is not searchable by a stranger, and that a pattern which is a
// regex to git behaves as a literal unless somebody asked otherwise.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const created = {
  ownerHandle: '',
  ownerId: 0,
  repositoryId: 0,
  name: '',
  diskPath: '',
  privateName: '',
  privateId: 0,
  privatePath: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function search(query: Record<string, string>, name = created.name): Promise<{ status: number, body: any }> {
  const parameters = new URLSearchParams({ owner: created.ownerHandle, repository: name, ...query })
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/search?${parameters}`, {
    headers: { Accept: 'application/json' },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('repositories').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    created.ownerHandle = unique('searchowner')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Search Owner', email: `${created.ownerHandle}@example.com`, handle: created.ownerHandle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const { initBare } = await import('../../app/Actions/Git/git')
    const { createCommit } = await import('../../app/Actions/Git/write')
    const { repositoryPath } = await import('../../app/Actions/Git/storage')

    const make = async (name: string, visibility: string): Promise<{ id: number, path: string }> => {
      const resolved = repositoryPath(created.ownerHandle, name)

      if (!resolved.ok)
        throw new Error('the repository path did not resolve')

      await mkdir(dirname(resolved.path!), { recursive: true })
      await initBare(resolved.path!, 'main')

      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.ownerId,
          name,
          visibility,
          default_branch: 'main',
          disk_path: resolved.relative!,
        })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), path: resolved.path! }
    }

    created.name = unique('searchrepo')
    const repository = await make(created.name, 'public')
    created.repositoryId = repository.id
    created.diskPath = repository.path

    const author = { name: 'Fixture', email: 'fixture@example.com' }

    const first = await createCommit(created.diskPath, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'The code to search',
      author,
      files: {
        'src/cart.ts': 'export function total(items: number[]) {\n  // add them up\n  return items.reduce((a, b) => a + b, 0)\n}\n',
        'src/money.ts': 'export const cents = (value: number) => Math.round(value * 100)\n',
        'docs/pricing.md': '# Pricing\n\nThe total is rounded per line.\n',
        'README.md': 'A fixture repository. Look for a.b.c in here.\n',
      },
    })

    if (!first.ok)
      throw new Error(`could not commit the fixture: ${first.error}`)

    // A second commit on a branch, so "at a ref" means something: the word
    // below exists on `work` and not on `main`.
    const second = await createCommit(created.diskPath, {
      branch: 'work',
      parentSha: first.sha,
      expectedBranchSha: null,
      message: 'Only on the branch',
      author,
      files: { 'src/later.ts': 'export const onlyOnTheBranch = true\n' },
    })

    if (!second.ok)
      throw new Error(`could not commit the branch: ${second.error}`)

    created.privateName = unique('searchprivate')
    const secret = await make(created.privateName, 'private')
    created.privateId = secret.id
    created.privatePath = secret.path

    const hidden = await createCommit(created.privatePath, {
      branch: 'main',
      parentSha: null,
      expectedBranchSha: null,
      message: 'Not for strangers',
      author,
      files: { 'secret.ts': 'export const confidential = true\n' },
    })

    if (!hidden.ok)
      throw new Error(`could not commit the private fixture: ${hidden.error}`)

    available = true
  }
  catch (error) {
    console.warn(`[code-search] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      for (const id of [created.repositoryId, created.privateId].filter(Boolean))
        await db.deleteFrom('repositories').where('id', '=', id).execute()

      if (created.ownerId)
        await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
    }

    for (const path of [created.diskPath, created.privatePath].filter(Boolean))
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('finding code', () => {
  test('a word in a file, with its path and line', async () => {
    if (!available)
      return

    const answer = await search({ q: 'reduce' })

    expect(answer.status).toBe(200)
    expect(answer.body.matches.length).toBe(1)
    expect(answer.body.matches[0].path).toBe('src/cart.ts')
    expect(answer.body.matches[0].line).toBe(3)
  }, 60_000)

  test('and a link to the exact line in the blob view', async () => {
    if (!available)
      return

    // A result somebody cannot get to the context of is a result they have to
    // navigate to by hand, which is what makes most code search unpleasant.
    const answer = await search({ q: 'reduce' })

    expect(String(answer.body.matches[0].url)).toContain(`/${created.ownerHandle}/${created.name}/blob/main/src/cart.ts#L3`)
  }, 60_000)

  test('with context either side, on the right sides', async () => {
    if (!available)
      return

    const answer = await search({ q: 'reduce', context: '1' })
    const match = answer.body.matches[0]

    expect(match.before).toEqual(['  // add them up'])
    expect(match.after).toEqual(['}'])
  }, 60_000)
})

describe('what the pattern means', () => {
  test('a literal search treats dots as dots', async () => {
    if (!available)
      return

    /*
     * `a.b.c` as a regex matches `add them up`, `a + b`, and most of the file.
     * As a literal it matches the one line of the README that says it - which
     * is what somebody typing it meant, and the difference between a useful
     * result and a page of noise.
     */
    const answer = await search({ q: 'a.b.c' })

    expect(answer.body.matches.length).toBe(1)
    expect(answer.body.matches[0].path).toBe('README.md')
  }, 60_000)

  test('and a regex search treats them as wildcards', async () => {
    if (!available)
      return

    /*
     * `t.tal` is nothing as a literal and `total` as a regex, so the two
     * searches disagree in the direction that proves the flag is doing
     * something - which `a.b.c` does not, since those letters happen to appear
     * in that order in only one file either way.
     */
    expect((await search({ q: 't.tal' })).body.matches).toEqual([])

    const asRegex = await search({ q: 't.tal', regex: '1' })

    expect(asRegex.body.matches.length).toBeGreaterThan(1)
    expect(asRegex.body.matches.some((one: any) => one.path === 'src/cart.ts')).toBe(true)
    expect(asRegex.body.matches.some((one: any) => one.path === 'docs/pricing.md')).toBe(true)
  }, 60_000)

  test('a broken regex says what is wrong rather than failing silently', async () => {
    if (!available)
      return

    // The commonest mistake, and one the person who typed it can fix in a
    // second if told.
    const answer = await search({ q: 'foo[bar', regex: '1' })

    expect(answer.status).toBe(422)
    expect(String(answer.body.error).length).toBeGreaterThan(0)
  }, 60_000)

  test('a pattern that looks like a flag is a pattern', async () => {
    if (!available)
      return

    /*
     * Without `-e`, git reads `--help` as its own flag and prints help into the
     * response. There is no shell here, so this is not injection - it is a
     * program reading its own arguments, which is the same problem wearing a
     * different name.
     */
    const answer = await search({ q: '--help' })

    expect(answer.status).toBe(200)
    expect(answer.body.matches).toEqual([])
  }, 60_000)

  test('and one character is refused rather than returning the repository', async () => {
    if (!available)
      return

    expect((await search({ q: 'e' })).status).toBe(422)
  }, 60_000)
})

describe('narrowing', () => {
  test('by language', async () => {
    if (!available)
      return

    const answer = await search({ q: 'total', language: 'markdown' })

    expect(answer.body.matches.length).toBe(1)
    expect(answer.body.matches[0].path).toBe('docs/pricing.md')
  }, 60_000)

  test('by path', async () => {
    if (!available)
      return

    const answer = await search({ q: 'total', path: 'src' })

    expect(answer.body.matches.every((one: any) => one.path.startsWith('src/'))).toBe(true)
  }, 60_000)
})

describe('the ref', () => {
  test('is what is searched, not whatever is newest', async () => {
    if (!available)
      return

    /*
     * The property that makes this better than an index: the answer is the code
     * as it is on that ref. A word committed only on a branch is not on main,
     * and an indexer that had not caught up would say otherwise.
     */
    expect((await search({ q: 'onlyOnTheBranch' })).body.matches).toEqual([])
    expect((await search({ q: 'onlyOnTheBranch', ref: 'work' })).body.matches.length).toBe(1)
  }, 60_000)
})

describe('who may search', () => {
  test('a private repository is not searchable by a stranger', async () => {
    if (!available)
      return

    /*
     * The same answer the browse endpoints give, and for the same reason: a
     * repository somebody can clone is one they can search, and one they cannot
     * is a 404 rather than a 403. Code search that leaked the *existence* of a
     * private repository through a status code would be a worse hole than the
     * search is a feature.
     */
    const answer = await search({ q: 'confidential' }, created.privateName)

    expect(answer.status).toBe(404)
  }, 60_000)
})
