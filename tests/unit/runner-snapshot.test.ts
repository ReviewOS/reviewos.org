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
import { snapshotKey } from '../../app/Actions/Workflow/cacheKey'
import { forgetTooLargeSnapshots, restoreCache, saveCache } from '../../app/Actions/Runner/cacheClient'
import { keyFor, lockfilesIn, NEVER_SNAPSHOT, packSnapshot, unpackSnapshot, worthCaching } from '../../app/Actions/Runner/snapshot'

const root = join(
  process.env.TMPDIR ?? '/tmp',
  `reviewos-snapshot-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')}`,
)

const source = join(root, 'workspace')
const target = join(root, 'restored')
const archive = join(root, 'snapshot.tar.gz')

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@test.local', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

beforeAll(() => {
  mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(source, '.git'), { recursive: true })
  mkdirSync(join(source, '.reviewos-runner'), { recursive: true })
  mkdirSync(target, { recursive: true })

  writeFileSync(join(source, 'bun.lock'), 'a lockfile')
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(source, 'node_modules', 'installed.js'), 'module.exports = 1')
  writeFileSync(join(source, 'node_modules', '.bin', 'linter'), '#!/bin/sh\necho ok\n')
  chmodSync(join(source, 'node_modules', '.bin', 'linter'), 0o755)
  symlinkSync('../installed.js', join(source, 'node_modules', '.bin', 'linked.js'))

  // The two that must never travel: the checkout is fetched, not restored, and
  // the runner's own directory holds this job's step files.
  git(source, 'init', '-q', '-b', 'main')
  git(source, 'add', 'bun.lock', '.gitignore')
  git(source, 'commit', '-qm', 'Initial checkout')
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

  test('a warm cache preserves changed source and cannot resurrect deleted source', async () => {
    const old = join(root, 'old-checkout')
    const current = join(root, 'current-checkout')
    const cached = join(root, 'old-dependencies.tar.gz')
    mkdirSync(old)
    writeFileSync(join(old, 'bun.lock'), 'the same dependencies')
    writeFileSync(join(old, 'helpers.ts'), 'export const oldHelper = 1')
    writeFileSync(join(old, 'deleted.ts'), 'obsolete source')
    git(old, 'init', '-q', '-b', 'main')
    git(old, 'add', '.')
    git(old, 'commit', '-qm', 'Old source')
    git(root, 'clone', '-q', old, current)
    writeFileSync(join(current, 'helpers.ts'), 'export const newHelper = 2')
    rmSync(join(current, 'deleted.ts'))
    git(current, 'add', '-A')
    git(current, 'commit', '-qm', 'Current source')
    mkdirSync(join(old, 'node_modules'))
    writeFileSync(join(old, 'node_modules', 'installed.js'), 'installed dependency')

    expect((await packSnapshot(old, cached)).ok).toBe(true)
    expect((await unpackSnapshot(cached, current)).ok).toBe(true)
    expect(await Bun.file(join(current, 'helpers.ts')).text()).toBe('export const newHelper = 2')
    expect(existsSync(join(current, 'deleted.ts'))).toBe(false)
    expect(await Bun.file(join(current, 'node_modules', 'installed.js')).text()).toBe('installed dependency')
    expect(Bun.spawnSync(['git', 'diff', '--exit-code'], { cwd: current }).exitCode).toBe(0)
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

  test('cannot restore a legacy snapshot that included checked-in source', () => {
    const legacy = snapshotKey({ lockfiles: lockfilesIn(source), runtime: 'bun@1.4.2', architecture: process.arch, image: null, extra: [] })
    expect(keyFor(source, { runtime: 'bun@1.4.2' })).not.toBe(legacy)
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

/*
 * A snapshot the instance cannot accept is not worth packing.
 *
 * Found on HQ's runner: every successful job spent two minutes compressing a
 * node_modules far past the 128 MiB the instance's HTTP server accepts, only for
 * the upload to come back 413 - and the next job of the same run did it again.
 */
describe('a snapshot past what the instance accepts', () => {
  const big = join(source, 'node_modules', 'incompressible.bin')

  beforeAll(() => {
    writeFileSync(big, crypto.getRandomValues(new Uint8Array(64 * 1024)))
  })

  afterAll(() => {
    rmSync(big, { force: true })
    forgetTooLargeSnapshots()
  })

  test('stops packing once the archive passes the limit, and leaves nothing behind', async () => {
    const packed = await packSnapshot(source, archive, 4096)

    expect(packed.ok).toBe(false)
    expect(packed.tooLarge).toBe(true)
    expect(String(packed.reason)).toContain('MiB this instance accepts')
    expect(existsSync(archive)).toBe(false)
  })

  test('is packed once per key on a runner, and never uploaded', async () => {
    let uploads = 0
    const server = Bun.serve({ port: 0, fetch: () => { uploads++; return new Response(null, { status: 201 }) } })

    try {
      const input = { baseUrl: `http://127.0.0.1:${server.port}`, jobToken: 't', key: 'too-large-key', workspace: source, scratch: root, maxBytes: 4096 }
      const first = await saveCache(input)
      const second = await saveCache(input)

      expect(first.saved).toBe(false)
      expect(String(first.reason)).toContain('MiB this instance accepts')
      expect(second.saved).toBe(false)
      expect(String(second.reason)).toContain('earlier job on this runner')
      expect(uploads).toBe(0)
    }
    finally {
      server.stop(true)
    }
  })

  test('the limit comes from the instance\'s restore answer, even on a miss', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204, headers: { 'X-Cache-Max-Bytes': '1234' } }) })

    try {
      const restored = await restoreCache({ baseUrl: `http://127.0.0.1:${server.port}`, jobToken: 't', key: 'k', workspace: target, scratch: root })

      expect(restored.restored).toBe(false)
      expect(restored.maxBytes).toBe(1234)
    }
    finally {
      server.stop(true)
    }
  })
})
