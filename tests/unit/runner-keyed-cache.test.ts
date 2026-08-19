// `actions/cache`, recognised and translated.
//
// A workflow arriving from GitHub has this step in it, and running the real
// action would fail: it talks to a cache service this instance does not
// implement. So the runner intercepts it - and what these tests hold is the
// recognition and the translation, because getting either wrong means either a
// step that runs the wrong program or one that silently caches nothing.

import { describe, expect, test } from 'bun:test'
import { cacheActionMode, isCacheAction, keyedCacheKey, pathsOf, requestFrom } from '../../app/Actions/Runner/keyedCache'

describe('recognising the step', () => {
  test('every form the action is written in', () => {
    expect(isCacheAction('actions/cache@v4')).toBe(true)
    expect(isCacheAction('actions/cache@v3')).toBe(true)
    expect(isCacheAction('actions/cache/restore@v4')).toBe(true)
    expect(isCacheAction('actions/cache/save@v4')).toBe(true)
    // Qualified with a host, which is how this instance's policy makes people
    // write it.
    expect(isCacheAction('github.com/actions/cache@v4')).toBe(true)
  })

  test('and nothing that merely looks like it', () => {
    /*
     * The cost of a false positive is high: a step that names somebody else's
     * action and gets this instance's caching instead is a step that did not
     * run the program its author asked for.
     */
    expect(isCacheAction('acme/cache@v1')).toBe(false)
    expect(isCacheAction('actions/cache-warmer@v1')).toBe(false)
    expect(isCacheAction('actions/setup-node@v4')).toBe(false)
    expect(isCacheAction('')).toBe(false)
    // No version at all is not a reference this runner resolves either way.
    expect(isCacheAction('actions/cache')).toBe(false)
  })

  test('the half of the action it is', () => {
    expect(cacheActionMode('actions/cache@v4')).toBe('both')
    expect(cacheActionMode('actions/cache/restore@v4')).toBe('restore')
    expect(cacheActionMode('actions/cache/save@v4')).toBe('save')
  })
})

describe('reading its inputs', () => {
  test('a path, a key, and restore keys one per line', () => {
    const request = requestFrom({
      'path': 'node_modules\n~/.bun/install/cache',
      'key': 'deps-linux-abc123',
      'restore-keys': 'deps-linux-\ndeps-',
    })

    expect(request.key).toBe('deps-linux-abc123')
    expect(request.restoreKeys).toEqual(['deps-linux-', 'deps-'])
    expect(pathsOf(request)).toEqual(['node_modules', '~/.bun/install/cache'])
  })

  test('a step with nothing in it is empty rather than broken', () => {
    const request = requestFrom({})

    expect(request.key).toBe('')
    expect(request.restoreKeys).toEqual([])
    expect(pathsOf(request)).toEqual([])
  })

  /**
   * Refused rather than sanitized. A workflow asking to cache `../..` is either
   * broken or trying something, and quietly rewriting it would hide both - and
   * an archive built from an absolute path unpacks somewhere nobody asked for.
   */
  test('a path leaving the workspace is dropped, not rewritten', () => {
    const request = requestFrom({ path: '../../etc\n/etc/passwd\nnode_modules\na/../../b' })

    expect(pathsOf(request)).toEqual(['node_modules'])
  })
})

describe('the key it is stored under', () => {
  test('is a hash, because an author\'s key is arbitrary text', () => {
    expect(keyedCacheKey('deps-linux-abc123')).toMatch(/^[0-9a-f]{64}$/)
    expect(keyedCacheKey('deps')).toBe(keyedCacheKey('deps'))
    expect(keyedCacheKey('deps')).not.toBe(keyedCacheKey('deps-'))
  })

  /**
   * Namespaced, so a keyed entry can never collide with a workspace snapshot.
   * They are different things in one table, and a collision would restore a
   * `node_modules` tar over somebody's `~/.cargo`.
   */
  test('and namespaced away from the snapshot keys', async () => {
    const { snapshotKey } = await import('../../app/Actions/Workflow/cacheKey')

    const collision = snapshotKey({ lockfiles: {}, runtime: '', architecture: '', image: '' })

    expect(keyedCacheKey('')).not.toBe(collision)
  })
})
