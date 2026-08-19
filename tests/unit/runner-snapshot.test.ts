// Making the archive, and unpacking it.
//
// Against a real directory and the real `tar`, because every interesting thing
// here is something an in-memory tar gets wrong: a symlinked binary, an
// executable bit, a path deeper than a tar header's name field. A test with a
// fake archiver would pass on all of them and the cache would still restore a
// `node_modules/.bin` full of files nothing can execute.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyFor, lockfilesIn, NEVER_SNAPSHOT, packSnapshot, unpackSnapshot, worthCaching } from '../../app/Actions/Runner/snapshot'

const root = join(
  process.env.TMPDIR ?? '/tmp',
  `reviewos-snapshot-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')}`,
)

const source = join(root, 'workspace')
const target = join(root, 'restored')
const archive = join(root, 'snapshot.tar.gz')

beforeAll(() => {
  mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(source, '.git'), { recursive: true })
  mkdirSync(join(source, '.reviewos-runner'), { recursive: true })
  mkdirSync(target, { recursive: true })

  writeFileSync(join(source, 'bun.lock'), 'a lockfile')
  writeFileSync(join(source, 'node_modules', 'installed.js'), 'module.exports = 1')
  writeFileSync(join(source, 'node_modules', '.bin', 'linter'), '#!/bin/sh\necho ok\n')
  chmodSync(join(source, 'node_modules', '.bin', 'linter'), 0o755)
  symlinkSync('../installed.js', join(source, 'node_modules', '.bin', 'linked.js'))

  // The two that must never travel: the checkout is fetched, not restored, and
  // the runner's own directory holds this job's step files.
  writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main')
  writeFileSync(join(source, '.reviewos-runner', 'output-0'), 'secret=value')
})

afterAll(() => {
  // Only what this test made, by the name it made it with.
  if (root.includes('reviewos-snapshot-'))
    rmSync(root, { recursive: true, force: true })
})

describe('what goes in a snapshot', () => {
  test('the installed tree, with its permissions and its symlinks', async () => {
    const packed = await packSnapshot(source, archive)

    expect(packed.ok).toBe(true)
    expect(packed.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(Number(packed.sizeBytes)).toBeGreaterThan(0)

    const unpacked = await unpackSnapshot(archive, target)

    expect(unpacked.ok).toBe(true)
    expect(await Bun.file(join(target, 'node_modules', 'installed.js')).text()).toBe('module.exports = 1')

    // The executable bit is the difference between a restored cache and a build
    // that cannot run its own tools.
    expect(statSync(join(target, 'node_modules', '.bin', 'linter')).mode & 0o111).toBeGreaterThan(0)

    // And the symlink is still a symlink rather than a copy, which is what
    // keeps a restored `node_modules` the size it was.
    expect(statSync(join(target, 'node_modules', '.bin', 'linked.js')).isFile()).toBe(true)
  })

  test('and never the checkout or the runner\'s own directory', async () => {
    /*
     * `.git` because the commit under test is fetched, not restored - a
     * snapshot carrying one would put an old repository over the code this run
     * is meant to be checking. `.reviewos-runner` because it holds this job's
     * step files, which is where an output a step marked sensitive lives.
     */
    for (const name of NEVER_SNAPSHOT)
      expect(existsSync(join(target, name))).toBe(false)
  })
})

describe('the key a workspace produces', () => {
  test('reads the lockfiles that are actually there', () => {
    expect(Object.keys(lockfilesIn(source))).toEqual(['bun.lock'])
    expect(lockfilesIn(join(root, 'nowhere'))).toEqual({})
  })

  test('changes when the lockfile does, and not when nothing did', async () => {
    const before = keyFor(source, { runtime: 'bun@1.3.14' })

    expect(keyFor(source, { runtime: 'bun@1.3.14' })).toBe(before)

    writeFileSync(join(source, 'bun.lock'), 'a different lockfile')

    expect(keyFor(source, { runtime: 'bun@1.3.14' })).not.toBe(before)
  })

  /**
   * A workspace with no lockfile turns caching off rather than producing a key
   * that means "any job in this repository" - which would restore one build's
   * leftovers into another's workspace.
   */
  test('a workspace with no lockfile is not worth caching', () => {
    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })

    expect(worthCaching(source)).toBe(true)
    expect(worthCaching(bare)).toBe(false)
  })
})
