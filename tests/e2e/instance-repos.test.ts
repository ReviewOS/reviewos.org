// The repository consistency check, against real rows and real directories.
//
// What it exists for is the sentence that matters most in the backup guide:
// Postgres and `storage/repos` have to come from the same moment. A database
// restored past the repository snapshot has pull requests whose commits are not
// on disk; the other way round has commits nothing references. Neither reports
// an error - the pages render, the API answers, and the first person to clone
// finds out.
//
// So this creates both halves of a matched pair, then breaks each half in turn.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const created = {
  userId: 0,
  handle: '',
  soundName: '',
  soundId: 0,
  /** A row whose directory was never created, as a restore-too-far leaves. */
  danglingName: '',
  danglingId: 0,
  /** A directory with no row, as a restore-not-far-enough leaves. */
  orphanPath: '',
  /** A directory that exists and is not a repository. */
  rubbishName: '',
  rubbishId: 0,
}

let available = false
let root = 'storage/repos'

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const storage = await import('../../app/Actions/Git/storage')
    root = storage.REPOSITORY_ROOT

    created.handle = unique('cons')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Consistency', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const makeRow = async (name: string) => {
      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.userId,
          name,
          visibility: 'public',
          default_branch: 'main',
          disk_path: `${created.handle}/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    // The matched pair: a row, and a real repository on disk.
    created.soundName = unique('sound')
    created.soundId = await makeRow(created.soundName)

    const { initBare } = await import('../../app/Actions/Git/git')
    mkdirSync(join(root, created.handle), { recursive: true })
    await initBare(join(root, `${created.handle}/${created.soundName}.git`))

    // A row whose directory is not there.
    created.danglingName = unique('dangling')
    created.danglingId = await makeRow(created.danglingName)

    // A directory with no row.
    created.orphanPath = join(root, created.handle, `${unique('orphan')}.git`)
    mkdirSync(created.orphanPath, { recursive: true })

    /*
     * A directory that exists and is not a repository, which is what a failed
     * clone or a half-extracted archive leaves. It passes every check that only
     * asks whether the path is there, and fails at the first fetch.
     */
    created.rubbishName = unique('rubbish')
    created.rubbishId = await makeRow(created.rubbishName)
    mkdirSync(join(root, `${created.handle}/${created.rubbishName}.git`), { recursive: true })

    available = true
  }
  catch (error) {
    console.warn(`[instance-repos] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('repositories').where('owner_id', '=', created.userId).where('owner_type', '=', 'user').execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    // Everything this made lives under one owner directory.
    if (created.handle)
      rmSync(join(root, created.handle), { recursive: true, force: true })
  }
}, 30_000)

describe('checking repositories', () => {
  test('says nothing about a row whose repository is there', async () => {
    if (!available)
      return

    const { checkRepositories } = await import('../../app/Ops/repositories')
    const report = await checkRepositories()

    const named = report.problems.filter(problem => problem.what.includes(created.soundName))

    expect(named).toEqual([])
  })

  test('finds a row whose directory is not', async () => {
    if (!available)
      return

    // What a database restored past the repository snapshot leaves behind.
    const { checkRepositories } = await import('../../app/Ops/repositories')
    const report = await checkRepositories()

    const found = report.problems.find(problem => problem.what.includes(created.danglingName))

    expect(found?.kind).toBe('missing-directory')
  })

  test('and a directory with no row', async () => {
    if (!available)
      return

    /*
     * The other direction, and the one that loses data: a repository nothing
     * references is invisible in the interface, so the next person clearing
     * disk space deletes it - and the row it needed was in the half of the
     * backup nobody restored.
     */
    const { checkRepositories } = await import('../../app/Ops/repositories')
    const report = await checkRepositories()

    const orphan = created.orphanPath.split('/').pop() ?? ''
    const found = report.problems.find(problem => problem.what.includes(orphan.replace('.git', '')))

    expect(found?.kind).toBe('orphan-directory')
  })

  test('and a directory git cannot read', async () => {
    if (!available)
      return

    // Present is not the same as readable. An empty directory left by a failed
    // clone passes any check that only asks whether the path exists.
    const { checkRepositories } = await import('../../app/Ops/repositories')
    const report = await checkRepositories()

    const found = report.problems.find(problem => problem.what.includes(created.rubbishName))

    expect(found?.kind).toBe('unreadable')
  })

  test('changes nothing', async () => {
    if (!available)
      return

    /*
     * Reported, never repaired. Both mismatches have two plausible fixes -
     * restore the other half, or delete this one - and which is right depends
     * on which snapshot was good. A command that guessed would eventually
     * delete the only copy of something.
     */
    const { checkRepositories } = await import('../../app/Ops/repositories')

    const before = await checkRepositories()
    await checkRepositories()
    const after = await checkRepositories()

    expect(after.checked).toBe(before.checked)
    expect(after.problems.length).toBe(before.problems.length)
  })
})
