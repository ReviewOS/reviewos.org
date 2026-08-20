// An archive that tries to write outside the workspace it is unpacked into.
//
// `docs/ci-security-review.md` scored this one "not met", in those words:
// "Extraction is the runner's, unguarded and untested." It was - the runner ran
// `tar -xzpf` and trusted whatever a previous run had packed.
//
// Two shapes escape a destination directory. An entry named `../../thing` walks
// out of it directly. A symlink entry pointing outside walks out more quietly:
// `link -> /etc` is one ordinary line, and `link/passwd` written afterwards is
// another, and neither looks like an attack on its own.
//
// The tests below build both, as real tarballs, and unpack them at a real
// directory. That is deliberate: a unit test over the pure rules would pass
// against a guard that was never called, which is the failure mode this whole
// file exists to rule out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  firstUnsafe,
  linkLandsWithin,
  refusalFor,
  withinRoot,
  zipListing,
} from '../../app/Actions/Runner/archiveSafety'
import { inspectSnapshot, unpackSnapshot } from '../../app/Actions/Runner/snapshot'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-archive-'))
})

afterAll(() => {
  // Only what this file made, by the name it made it with.
  if (root)
    rmSync(root, { recursive: true, force: true })
})

/** Build a tarball from a directory, the way a runner packs a workspace. */
async function pack(name: string, build: (staging: string) => Promise<void>): Promise<string> {
  const staging = join(root, `${name}-src`)
  const archive = join(root, `${name}.tgz`)

  await mkdir(staging, { recursive: true })
  await build(staging)

  const packed = Bun.spawn(['tar', '-czf', archive, '-C', staging, '.'], { stdout: 'pipe', stderr: 'pipe' })

  await packed.exited

  return archive
}

describe('the rules, on their own', () => {
  test('an ordinary path is inside the workspace', () => {
    expect(withinRoot('node_modules/typescript/package.json')).toBe(true)
    expect(withinRoot('./a/b')).toBe(true)
  })

  test('an absolute path is not, in any of its spellings', () => {
    // A destination is what an absolute path ignores, which is the whole of the
    // problem with one.
    expect(withinRoot('/etc/passwd')).toBe(false)
    expect(withinRoot('\\windows\\system32')).toBe(false)
    expect(withinRoot('C:/Windows')).toBe(false)
  })

  test('and a `..` that leaves the root is not, even if a later segment returns', () => {
    /*
     * `a/../b` is `b` and is fine - a `..` cancelled by the segment before it
     * never leaves. `../x/../workspace` reaches outside on the way through, and
     * an extraction follows the path as written rather than as simplified.
     */
    expect(withinRoot('a/../b')).toBe(true)
    expect(withinRoot('../etc/passwd')).toBe(false)
    expect(withinRoot('a/../../etc')).toBe(false)
    expect(withinRoot('../x/../workspace')).toBe(false)
  })

  test('a relative link inside the tree is allowed, because that is what a cache is made of', () => {
    /*
     * The rule that must not be over-tightened. `node_modules/.bin/*` are
     * symlinks full of `..`, and they are most of what a dependency cache is
     * for - a guard that refused every `..` in a target would refuse every real
     * snapshot and look like caching being broken.
     */
    expect(linkLandsWithin('node_modules/.bin/tsc', '../typescript/bin/tsc')).toBe(true)
  })

  test('and a link pointing out of the tree is not', () => {
    expect(linkLandsWithin('node_modules/.bin/tsc', '/etc/passwd')).toBe(false)
    expect(linkLandsWithin('a/link', '../../../etc/passwd')).toBe(false)
    expect(linkLandsWithin('a/link', '')).toBe(false)
  })

  test('the two listings are read as a pair, by position', () => {
    /*
     * The paths come from `-tzf`, which both tars spell identically, and the
     * type and target from `-tvzf`, whose columns they lay out differently.
     * Zipping by index is what avoids having to know where a column starts.
     */
    const names = 'src/file.txt\nsrc/link\n'
    const verbose = [
      '-rw-r--r--  0 chris  wheel  3 Aug 20 09:12 src/file.txt',
      'lrwxr-xr-x  0 chris  wheel  0 Aug 20 09:12 src/link -> /etc/passwd',
    ].join('\n')

    const entries = zipListing(names, verbose)

    expect(entries[0]).toEqual({ path: 'src/file.txt', target: null, isLink: false })
    expect(entries[1]).toEqual({ path: 'src/link', target: '/etc/passwd', isLink: true })
    expect(refusalFor(entries[1]!)).toContain('outside the workspace')
  })

  test('and listings that disagree about how many entries there are refuse the archive', () => {
    // Two reads of one file that do not agree is something this code cannot
    // name - and the entry a zip would drop is the one an attacker wants
    // dropped.
    expect(firstUnsafe('a\nb\n', 'only one line')?.reason).toContain('different number of entries')
  })
})

describe('against real archives', () => {
  test('an ordinary snapshot unpacks, symlinked binaries and all', async () => {
    /*
     * First, because a guard that refuses everything passes every test below
     * and breaks every real cache. This is the one that says the others mean
     * something.
     */
    const archive = await pack('good', async (staging) => {
      await mkdir(join(staging, 'node_modules/.bin'), { recursive: true })
      await mkdir(join(staging, 'node_modules/typescript/bin'), { recursive: true })
      writeFileSync(join(staging, 'node_modules/typescript/bin/tsc'), '#!/bin/sh\n')
      await symlink('../typescript/bin/tsc', join(staging, 'node_modules/.bin/tsc'))
    })

    expect(await inspectSnapshot(archive)).toBeNull()

    const into = join(root, 'good-out')

    await mkdir(into, { recursive: true })

    const unpacked = await unpackSnapshot(archive, into)

    expect(unpacked.ok).toBe(true)
    expect(existsSync(join(into, 'node_modules/.bin/tsc'))).toBe(true)
  })

  test('a symlink pointing out of the workspace is refused, and nothing is written', async () => {
    const archive = await pack('evil-link', async (staging) => {
      await mkdir(join(staging, 'node_modules/.bin'), { recursive: true })
      await symlink('/etc/passwd', join(staging, 'node_modules/.bin/tsc'))
    })

    const found = await inspectSnapshot(archive)

    expect(found).not.toBeNull()
    expect(found?.reason).toContain('outside the workspace')

    const into = join(root, 'evil-link-out')

    await mkdir(into, { recursive: true })

    const unpacked = await unpackSnapshot(archive, into)

    expect(unpacked.ok).toBe(false)
    expect(unpacked.reason).toContain('refused')

    /*
     * The part that matters: refused *before* extraction, so the workspace is
     * untouched rather than half-populated. A guard that cleaned up afterwards
     * would already have followed the symlink.
     */
    expect(existsSync(join(into, 'node_modules'))).toBe(false)
  })

  test('and a link that escapes by climbing is refused too', async () => {
    // The same attack without an absolute path, which is the version that gets
    // past a check for a leading slash.
    const archive = await pack('climb', async (staging) => {
      await mkdir(join(staging, 'deep'), { recursive: true })
      await symlink('../../../../etc', join(staging, 'deep/out'))
    })

    expect((await inspectSnapshot(archive))?.reason).toContain('outside the workspace')
  })

  test('a `../` entry is refused, against an archive crafted to contain one', async () => {
    /*
     * `tar` will not *create* this from a directory - it refuses to pack a path
     * that climbs out - so the archive is built with this repository's own tar
     * writer, which asks no such questions. That is the point: the attacker is
     * not using the system tar either.
     */
    const { buildTar } = await import('../../app/Actions/Artifact/tar')
    const { gzipSync } = await import('node:zlib')

    const crafted = join(root, 'climb-out.tgz')

    writeFileSync(crafted, gzipSync(buildTar([
      { name: 'node_modules/fine.txt', bytes: new TextEncoder().encode('ok\n') },
      { name: '../../escaped.txt', bytes: new TextEncoder().encode('outside\n') },
    ])))

    const found = await inspectSnapshot(crafted)

    expect(found).not.toBeNull()
    expect(found?.path).toBe('../../escaped.txt')
    expect(found?.reason).toContain('outside the workspace')

    const into = join(root, 'climb-out-dir')

    await mkdir(into, { recursive: true })

    expect((await unpackSnapshot(crafted, into)).ok).toBe(false)

    // Not even the legitimate entry landed: one bad entry refuses the archive,
    // rather than unpacking the acceptable half of somebody's attack.
    expect(existsSync(join(into, 'node_modules'))).toBe(false)
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  })

  test('an archive that cannot be read at all is refused rather than attempted', async () => {
    // An archive this runner cannot list is one it certainly should not unpack.
    const broken = join(root, 'broken.tgz')

    writeFileSync(broken, 'this is not a gzip stream')

    expect((await inspectSnapshot(broken))?.reason).toContain('index could not be read')
    expect((await unpackSnapshot(broken, root)).ok).toBe(false)
  })
})
