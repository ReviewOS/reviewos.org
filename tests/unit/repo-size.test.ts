// What a repository weighs.
//
// The parsing is tested rather than the measuring, because the mistake this
// guards against is reading the wrong key: `count` is a number of objects and
// `size` is a number of kilobytes, they sit next to each other in the output,
// and recording one as the other produces a plausible number that is wrong by
// whatever the average object size happens to be.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measure, parseCountObjects } from '../../app/Actions/Repo/size'

/** What `git count-objects -v` actually prints. */
const SAMPLE = `count: 12
size: 48
in-pack: 1043
packs: 1
size-pack: 2144
prune-packable: 0
garbage: 0
size-garbage: 0`

describe('parseCountObjects', () => {
  test('adds loose and packed, and keeps them apart', () => {
    const size = parseCountObjects(SAMPLE)

    expect(size).toEqual({ kb: 2192, looseKb: 48, packKb: 2144, looseObjects: 12 })
  })

  /** `count` is objects. Reading it as kilobytes is the whole bug. */
  test('does not read the object count as a size', () => {
    expect(parseCountObjects(SAMPLE).kb).not.toBe(12)
    expect(parseCountObjects('count: 900\nsize: 4\nsize-pack: 0').kb).toBe(4)
  })

  test('a freshly packed repository is all pack and no loose', () => {
    const size = parseCountObjects('count: 0\nsize: 0\nin-pack: 40\npacks: 1\nsize-pack: 96')

    expect(size.looseKb).toBe(0)
    expect(size.kb).toBe(96)
  })

  test('an empty repository weighs nothing rather than failing', () => {
    expect(parseCountObjects('count: 0\nsize: 0\nin-pack: 0\npacks: 0\nsize-pack: 0').kb).toBe(0)
    expect(parseCountObjects('').kb).toBe(0)
  })

  test('ignores anything that is not a number', () => {
    expect(parseCountObjects('size: unknown\nsize-pack: 8').kb).toBe(8)
    expect(parseCountObjects('garbage line with no colon').kb).toBe(0)
  })
})

/**
 * Against a real repository, because the format is git's to change and a
 * hand-written sample would keep passing after it did.
 */
describe('measure', () => {
  test('reports a real repository as bigger than an empty one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-size-'))

    try {
      const bare = join(root, 'repo.git')
      spawnSync('git', ['init', '--bare', '--initial-branch=main', bare])

      const empty = await measure(bare)
      expect(empty).not.toBeNull()
      expect(empty!.kb).toBe(0)

      const work = join(root, 'work')
      mkdirSync(work)
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      }
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: work, env })
      writeFileSync(join(work, 'big.txt'), 'x'.repeat(200_000))
      spawnSync('git', ['add', '.'], { cwd: work, env })
      spawnSync('git', ['commit', '-m', 'big'], { cwd: work, env })
      spawnSync('git', ['push', bare, 'main'], { cwd: work, env })

      const after = await measure(bare)

      expect(after).not.toBeNull()
      expect(after!.kb).toBeGreaterThan(0)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a path that is not a repository measures as nothing, not as a crash', async () => {
    expect(await measure(join(tmpdir(), 'reviewos-not-a-repository'))).toBeNull()
  })
})
