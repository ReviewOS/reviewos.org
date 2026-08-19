// The push write-ahead log, against real git.
//
// The parts that can be pinned without a database are the parts that decide
// whether a restore works: which revisions go into the bundle, whether the
// bundle git produces actually verifies, and whether replaying ref updates
// puts a repository back where it was. A bundle that is written but never
// verified is a backup nobody has tested, which is the failure this whole
// sub-phase exists to avoid.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bundleArgs, bundleKey, carriesObjects, replay, temporaryRef, verifyBundle, walUpdatesFrom } from '../../app/Actions/Git/wal'
import { initBare, runGit } from '../../app/Actions/Git/git'

const ZERO = '0'.repeat(40)

let root: string
let bare: string
let work: string
let firstSha = ''
let secondSha = ''

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })

  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)

  return result.stdout.toString().trim()
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-wal-'))
  bare = join(root, 'origin.git')
  work = join(root, 'work')

  await initBare(bare, 'main')

  git(root, 'clone', bare, 'work')
  await Bun.write(join(work, 'README.md'), '# one\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')
  firstSha = git(work, 'rev-parse', 'HEAD')

  await Bun.write(join(work, 'second.txt'), 'two\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'second')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')
  secondSha = git(work, 'rev-parse', 'HEAD')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('bundleKey', () => {
  test('sorts lexically in sequence order, so a listing is chronological', () => {
    const keys = [bundleKey(7, 10), bundleKey(7, 2), bundleKey(7, 1)]

    expect([...keys].sort()).toEqual([bundleKey(7, 1), bundleKey(7, 2), bundleKey(7, 10)])
  })
})

describe('carriesObjects', () => {
  test('a deletion brings nothing to bundle', () => {
    expect(carriesObjects([{ ref: 'refs/heads/gone', before: firstSha, after: ZERO }])).toBe(false)
  })

  test('an update does', () => {
    expect(carriesObjects([{ ref: 'refs/heads/main', before: firstSha, after: secondSha }])).toBe(true)
  })

  test('a push that both deletes and updates still bundles', () => {
    expect(carriesObjects([
      { ref: 'refs/heads/gone', before: firstSha, after: ZERO },
      { ref: 'refs/heads/main', before: firstSha, after: secondSha },
    ])).toBe(true)
  })
})

describe('bundleArgs', () => {
  test('bundles by ref name and excludes what is already here', () => {
    const args = bundleArgs([temporaryRef(4, 0)], ['refs/heads/other'])

    expect(args.slice(0, 4)).toEqual(['bundle', 'create', '--quiet', '-'])
    expect(args).toContain('refs/reviewos-wal/4/0')
    expect(args).toContain('^refs/heads/other')
  })

  /**
   * The bug this signature exists to prevent, and the reason it takes refs
   * rather than the shas it obviously "should".
   *
   * `git bundle create - <sha>` answers "Refusing to create empty bundle": a
   * bundle records *references*, and a bare revision names none. The version
   * that passed shas wrote a seventeen-byte header with no pack behind it,
   * reported success, and restored nothing - and the test meant to cover it
   * bundled with `--all`, so it proved git works rather than that these
   * arguments do. Verified against real git below.
   */
  test('never passes a bare sha', () => {
    const args = bundleArgs([temporaryRef(4, 0), temporaryRef(4, 1)], [])

    expect(args.filter(argument => /^[0-9a-f]{40}$/.test(argument))).toEqual([])
  })

  /**
   * The exclusion is the difference between a bundle of this push and a bundle
   * of the whole project. Without it the first push of a fork writes the
   * upstream's entire history into the log, every time.
   */
  test('exclusions are ref names too, negated', () => {
    const args = bundleArgs([temporaryRef(1, 0)], ['refs/heads/main', 'refs/tags/v1'])

    expect(args).toContain('^refs/heads/main')
    expect(args).toContain('^refs/tags/v1')
  })
})

describe('temporaryRef', () => {
  test('is namespaced and scoped per push, so two in flight cannot collide', () => {
    expect(temporaryRef(7, 0)).toBe('refs/reviewos-wal/7/0')
    expect(temporaryRef(7, 1)).not.toBe(temporaryRef(8, 1))
  })

  test('sits outside every namespace a repository already uses', () => {
    const ref = temporaryRef(1, 0)

    expect(ref.startsWith('refs/heads/')).toBe(false)
    expect(ref.startsWith('refs/tags/')).toBe(false)
    expect(ref.startsWith('refs/pull/')).toBe(false)
  })
})

describe('what git does with these arguments', () => {
  /**
   * The end of the story the two tests above tell: parking the tip under a
   * temporary ref is what makes git produce a bundle with a pack in it, and
   * the pack is what restores.
   */
  test('a parked ref bundles into something that carries objects', async () => {
    const parked = temporaryRef(99, 0)
    await runGit(bare, ['update-ref', parked, secondSha])

    const bundlePath = join(root, 'parked.bundle')

    try {
      // The same argument list the push path builds, with `-` swapped for a
      // file so the test can weigh the result.
      const args = bundleArgs([parked], []).map(argument => (argument === '-' ? bundlePath : argument))
      const created = await runGit(bare, args)

      expect(created.ok, created.stderr).toBe(true)

      const written = await Bun.file(bundlePath).size

      // Comfortably past a bare header, which is all the sha version wrote.
      expect(written).toBeGreaterThan(100)

      const restored = join(root, 'from-parked.git')
      await initBare(restored, 'main')

      const fetched = await runGit(restored, ['fetch', bundlePath, '+refs/*:refs/*'])
      expect(fetched.ok, fetched.stderr).toBe(true)

      const present = await runGit(restored, ['cat-file', '-e', `${secondSha}^{commit}`])
      expect(present.ok).toBe(true)
    }
    finally {
      await runGit(bare, ['update-ref', '-d', parked])
    }
  })

  test('a bare sha is refused by git, which is why the signature changed', async () => {
    const bundlePath = join(root, 'bare.bundle')
    const created = await runGit(bare, ['bundle', 'create', bundlePath, secondSha])

    expect(created.ok).toBe(false)
    expect(created.stderr).toContain('empty bundle')
  })
})

describe('the bundle git actually produces', () => {
  /**
   * The test that makes this a backup rather than a directory of blobs: git
   * writes it, git verifies it, and the objects come back out.
   */
  test('verifies, and restores into an empty repository', async () => {
    const bundlePath = join(root, 'push.bundle')

    // What `recordPush` runs, minus the streaming into the blob store.
    const created = await runGit(bare, ['bundle', 'create', bundlePath, '--all'])
    expect(created.ok).toBe(true)

    const verdict = await verifyBundle(bare, bundlePath)
    expect(verdict.ok, verdict.reason).toBe(true)

    // Restored into a repository that has never seen this history.
    const restored = join(root, 'restored.git')
    await initBare(restored, 'main')

    const fetched = await runGit(restored, ['fetch', bundlePath, '+refs/heads/*:refs/heads/*'])
    expect(fetched.ok, fetched.stderr).toBe(true)

    const head = await runGit(restored, ['rev-parse', 'refs/heads/main'])
    expect(head.stdout.trim()).toBe(secondSha)
  })

  test('a file that is not a bundle fails verification rather than passing quietly', async () => {
    const bogus = join(root, 'not-a-bundle')
    await Bun.write(bogus, 'this is not a packfile\n')

    const verdict = await verifyBundle(bare, bogus)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason.length).toBeGreaterThan(0)
  })
})

describe('replay', () => {
  test('moves refs to where the log says they ended', async () => {
    const target = join(root, 'replayed.git')
    await initBare(target, 'main')

    // The objects arrive first - replay moves refs, it does not fetch. The two
    // being separate steps is what keeps a half-done replay from looking done.
    await runGit(target, ['fetch', bare, '+refs/heads/*:refs/heads/*'])
    await runGit(target, ['update-ref', '-d', 'refs/heads/main'])

    const outcome = await replay(target, [{
      id: 1,
      repositoryId: 1,
      sequence: 1,
      updates: [{ ref: 'refs/heads/main', before: ZERO, after: secondSha }],
      blobKey: null,
      blobBytes: 0,
      status: 'committed',
    }])

    expect(outcome.failed).toEqual([])
    expect(outcome.applied).toBe(1)

    const head = await runGit(target, ['rev-parse', 'refs/heads/main'])
    expect(head.stdout.trim()).toBe(secondSha)
  })

  test('applies a deletion as a deletion', async () => {
    const target = join(root, 'deleted.git')
    await initBare(target, 'main')
    await runGit(target, ['fetch', bare, '+refs/heads/*:refs/heads/*'])

    const outcome = await replay(target, [{
      id: 1,
      repositoryId: 1,
      sequence: 1,
      updates: [{ ref: 'refs/heads/main', before: secondSha, after: ZERO }],
      blobKey: null,
      blobBytes: 0,
      status: 'committed',
    }])

    expect(outcome.failed).toEqual([])

    const head = await runGit(target, ['rev-parse', '--verify', 'refs/heads/main'])
    expect(head.ok).toBe(false)
  })

  /** A voided entry is one that never landed. Replaying it would invent history. */
  test('skips voided entries', async () => {
    const target = join(root, 'voided.git')
    await initBare(target, 'main')
    await runGit(target, ['fetch', bare, '+refs/heads/*:refs/heads/*'])

    const outcome = await replay(target, [{
      id: 1,
      repositoryId: 1,
      sequence: 1,
      updates: [{ ref: 'refs/heads/main', before: secondSha, after: ZERO }],
      blobKey: null,
      blobBytes: 0,
      status: 'void',
    }])

    expect(outcome.applied).toBe(0)

    const head = await runGit(target, ['rev-parse', 'refs/heads/main'])
    expect(head.stdout.trim()).toBe(secondSha)
  })
})

describe('walUpdatesFrom', () => {
  test('keeps the whole ref transaction, not one ref of it', () => {
    const updates = walUpdatesFrom([
      { ref: 'refs/heads/main', before: firstSha, after: secondSha, name: 'main', kind: 'branch', change: 'updated' } as any,
      { ref: 'refs/tags/v1', before: ZERO, after: secondSha, name: 'v1', kind: 'tag', change: 'created' } as any,
    ])

    expect(updates).toHaveLength(2)
    expect(updates[0]).toEqual({ ref: 'refs/heads/main', before: firstSha, after: secondSha })
  })
})
