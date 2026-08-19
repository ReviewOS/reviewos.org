// What makes two runs' caches the same cache.
//
// Derived rather than written by an author, because every CI system that asks
// for a key expression gets the same bug reported forever: the right glob and
// no runtime version in it, so a build that moved from one Bun to another
// restores the old one's native modules and fails somewhere unrelated.

import { describe, expect, test } from 'bun:test'
import { lockfileDigest, LOCKFILE_NAMES, snapshotKey } from '../../app/Actions/Workflow/cacheKey'

const base = {
  lockfiles: { 'bun.lock': lockfileDigest('one') },
  runtime: 'bun@1.3.14',
  architecture: 'arm64',
  image: '',
}

describe('what changes the key', () => {
  test('a lockfile that changed', () => {
    const after = { ...base, lockfiles: { 'bun.lock': lockfileDigest('two') } }

    expect(snapshotKey(after)).not.toBe(snapshotKey(base))
  })

  test('a lockfile that appeared, even an empty one', () => {
    // A repository that adds a second lockfile has changed its dependencies. A
    // key built from digests alone would be equal to the old one whenever the
    // new file happened to be empty.
    const after = { ...base, lockfiles: { ...base.lockfiles, 'Cargo.lock': lockfileDigest('') } }

    expect(snapshotKey(after)).not.toBe(snapshotKey(base))
  })

  test('the runtime, the architecture, and the image', () => {
    expect(snapshotKey({ ...base, runtime: 'bun@1.2.0' })).not.toBe(snapshotKey(base))
    expect(snapshotKey({ ...base, architecture: 'x64' })).not.toBe(snapshotKey(base))
    expect(snapshotKey({ ...base, image: 'oven/bun@sha256:abc' })).not.toBe(snapshotKey(base))
  })

  test('anything the workflow added on purpose', () => {
    expect(snapshotKey({ ...base, extra: ['generated-schema-v2'] })).not.toBe(snapshotKey(base))
  })
})

describe('what does not change the key', () => {
  test('the order the lockfiles were found in', () => {
    // A cache that misses for a reason nobody can see is indistinguishable from
    // caching being broken.
    const one = snapshotKey({ ...base, lockfiles: { 'a.lock': 'aa', 'b.lock': 'bb' } })
    const two = snapshotKey({ ...base, lockfiles: { 'b.lock': 'bb', 'a.lock': 'aa' } })

    expect(one).toBe(two)
  })

  test('running it twice on the same inputs', () => {
    expect(snapshotKey(base)).toBe(snapshotKey(base))
  })
})

describe('what the key is', () => {
  test('a sha-256, so it is safe as a storage key and as a column', () => {
    expect(snapshotKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the author\'s extra values keep their order, because it is theirs', () => {
    // Sorting them would silently merge two keys somebody meant to keep apart.
    expect(snapshotKey({ ...base, extra: ['a', 'b'] })).not.toBe(snapshotKey({ ...base, extra: ['b', 'a'] }))
  })
})

describe('the lockfiles worth looking for', () => {
  test('a fixed list rather than a glob', () => {
    // A glob over a checkout finds the lockfiles of every vendored fixture in
    // the repository, and a key that changes when a fixture does never hits.
    expect(LOCKFILE_NAMES).toContain('bun.lock')
    expect(LOCKFILE_NAMES).toContain('Cargo.lock')
    expect(new Set(LOCKFILE_NAMES).size).toBe(LOCKFILE_NAMES.length)
  })
})
