// Checkpoints, and the pruning they make safe.
//
// A checkpoint is what keeps the write-ahead log from being an unbounded
// history: a full bundle of the repository at a sequence, after which the
// entries before it are redundant. That makes the pruning rules the dangerous
// part of this file - they delete backup material, and the two guards below
// are what stop them deleting the only copy of something.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { advertiseBundle, checkpointKey, checkpointSequence, latestCheckpoint, prunable, withdrawBundle, writeCheckpoint } from '../../app/Actions/Git/checkpoint'
import { LocalBlobStore, useBlobStore } from '../../app/Actions/Git/blobs'
import { initBare, runGit } from '../../app/Actions/Git/git'

let root: string
let bare: string
let store: LocalBlobStore
let headSha = ''

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
  root = mkdtempSync(join(tmpdir(), 'reviewos-checkpoint-'))
  bare = join(root, 'origin.git')

  store = new LocalBlobStore(join(root, 'blobs'))
  useBlobStore(store)

  await initBare(bare, 'main')

  const work = join(root, 'work')
  git(root, 'clone', bare, 'work')
  await Bun.write(join(work, 'README.md'), '# checkpoint\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')
  headSha = git(work, 'rev-parse', 'HEAD')
})

afterAll(() => {
  // Only the directory this file created, by the name it created it with.
  useBlobStore(null)
  rmSync(root, { recursive: true, force: true })
})

describe('checkpointKey', () => {
  test('sorts lexically in sequence order, which is the whole index', () => {
    const keys = [checkpointKey(3, 10), checkpointKey(3, 2), checkpointKey(3, 100)]

    expect([...keys].sort()).toEqual([checkpointKey(3, 2), checkpointKey(3, 10), checkpointKey(3, 100)])
  })

  test('round-trips through checkpointSequence', () => {
    expect(checkpointSequence(checkpointKey(9, 41))).toBe(41)
  })

  /** A WAL entry's bundle is not a checkpoint, and must never be read as one. */
  test('an ordinary entry key is not a checkpoint', () => {
    expect(checkpointSequence('wal/9/000000000041.bundle')).toBeNull()
    expect(checkpointSequence('artifacts/9/log.txt')).toBeNull()
  })
})

describe('prunable', () => {
  const entry = (sequence: number, status = 'committed') => ({
    id: sequence,
    sequence,
    status,
    blobKey: `wal/1/${sequence}.bundle`,
  })

  test('drops what the checkpoint covers, beyond the entries to keep', () => {
    const doomed = prunable([entry(1), entry(2), entry(3), entry(4), entry(5)], 5, 2)

    expect(doomed.map(item => item.sequence)).toEqual([1, 2, 3])
  })

  /**
   * The guard that matters most. Anything after the checkpoint is not covered
   * by it, so those bundles are the only copy of those pushes.
   */
  test('never touches an entry past the checkpoint', () => {
    const doomed = prunable([entry(9), entry(10), entry(11)], 10, 0)

    expect(doomed.map(item => item.sequence)).toEqual([9, 10])
    expect(doomed.some(item => item.sequence === 11)).toBe(false)
  })

  /**
   * A pending entry is one the reconciler has not decided about. Deleting it
   * turns an open question into a gap nobody can explain.
   */
  test('never prunes a pending entry, however old', () => {
    const doomed = prunable([entry(1, 'pending'), entry(2), entry(3, 'void')], 5, 0)

    expect(doomed.map(item => item.sequence)).toEqual([2, 3])
  })

  test('keeps everything when the retention window covers the whole log', () => {
    expect(prunable([entry(1), entry(2)], 2, 500)).toEqual([])
  })

  test('keeps everything when there is no checkpoint to justify it', () => {
    expect(prunable([entry(1), entry(2)], 0, 0)).toEqual([])
  })
})

describe('writeCheckpoint', () => {
  test('writes a bundle with a pack in it, and finds it again', async () => {
    // `repack: false` so the test is about the bundle rather than about gc.
    const written = await writeCheckpoint(7, bare, 12, { repack: false })

    expect(written).not.toBeNull()
    expect(written!.sequence).toBe(12)
    expect(written!.bytes).toBeGreaterThan(100)

    const found = await latestCheckpoint(7, store)
    expect(found?.sequence).toBe(12)
  })

  /**
   * The failure this was written for, which took four blocked deploys to catch.
   *
   * A bundle arrives on a pipe, and a pipe whose reader attaches after the
   * child has closed hands back nothing at all: git exits 0, the store records
   * zero bytes, and a repository with plenty to bundle reports no checkpoint.
   * `writeCheckpoint` used to `await blobStore()` between the spawn and the
   * read, which is enough on a loaded machine and never enough on a laptop -
   * so it failed only on CI, only for the first call in this file.
   *
   * Anything awaited between the two brings it back, so this asserts the thing
   * that would be lost: bytes, over and over, with work in between.
   */
  test('reads the bundle even when the process is busy, which is the whole ordering', async () => {
    for (const sequence of [21, 22, 23]) {
      const written = await writeCheckpoint(7, bare, sequence, { repack: false })

      expect(written).not.toBeNull()
      expect(written!.bytes).toBeGreaterThan(100)

      // Work between the calls, the way a suite or a busy box has work.
      await Bun.sleep(25)
    }
  })

  test('the newest wins when there are several', async () => {
    await writeCheckpoint(8, bare, 5, { repack: false })
    await writeCheckpoint(8, bare, 40, { repack: false })
    await writeCheckpoint(8, bare, 9, { repack: false })

    expect((await latestCheckpoint(8, store))?.sequence).toBe(40)
  })

  test('a repository with nothing in it produces no checkpoint', async () => {
    const empty = join(root, 'empty.git')
    await initBare(empty, 'main')

    // Not a failure - an empty repository is a legitimate state, and a
    // header-only blob in the store would be a checkpoint that restores
    // nothing while looking like one that does.
    expect(await writeCheckpoint(11, empty, 1, { repack: false })).toBeNull()
    expect(await latestCheckpoint(11, store)).toBeNull()
  })

  test('the checkpoint restores the repository on its own', async () => {
    const written = await writeCheckpoint(12, bare, 3, { repack: false })
    expect(written).not.toBeNull()

    const stream = await store.get(written!.key)
    const path = join(root, 'checkpoint.bundle')
    await Bun.write(path, await new Response(stream!).arrayBuffer())

    const restored = join(root, 'restored.git')
    await initBare(restored, 'main')

    const fetched = await runGit(restored, ['fetch', path, '+refs/*:refs/*'])
    expect(fetched.ok, fetched.stderr).toBe(true)

    const tip = await runGit(restored, ['rev-parse', 'refs/heads/main'])
    expect(tip.stdout.trim()).toBe(headSha)
  })
})

describe('advertiseBundle', () => {
  /**
   * `bundle-uri` is git's own answer to a clone storm: a client fetches the
   * checkpoint over plain HTTP and asks `upload-pack` only for what landed
   * since. Written into the repository's config, so it is git advertising it
   * rather than this application intercepting anything - which is why the
   * assertion is against `git config` and not against our own state.
   */
  test('writes the config git reads when advertising', async () => {
    const url = 'https://forge.example/acme/app/bundles/checkpoint'

    expect(await advertiseBundle(bare, url)).toBe(true)

    const advertised = await runGit(bare, ['config', '--get', 'uploadpack.advertiseBundleURIs'])
    expect(advertised.stdout.trim()).toBe('true')

    const uri = await runGit(bare, ['config', '--get', 'bundle.checkpoint.uri'])
    expect(uri.stdout.trim()).toBe(url)

    // `all`, not `any`: the checkpoint carries every ref but is not the whole
    // story on its own - the client still needs what landed after it.
    const mode = await runGit(bare, ['config', '--get', 'bundle.mode'])
    expect(mode.stdout.trim()).toBe('all')
  })

  test('withdrawing stops the advertisement', async () => {
    await advertiseBundle(bare, 'https://forge.example/acme/app/bundles/checkpoint')
    await withdrawBundle(bare)

    const uri = await runGit(bare, ['config', '--get', 'bundle.checkpoint.uri'])
    expect(uri.ok).toBe(false)

    const advertised = await runGit(bare, ['config', '--get', 'uploadpack.advertiseBundleURIs'])
    expect(advertised.stdout.trim()).toBe('false')
  })
})
