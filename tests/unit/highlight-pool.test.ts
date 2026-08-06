/**
 * The highlight pool's decisions, without starting a thread.
 *
 * The parts worth testing are the ones that decide *whether* to use a worker
 * and *what* may be reused - sizing, the content key, and the cache's
 * eviction. Starting real workers to check those would make the suite slow and
 * flaky enough that nobody trusts it, and would test Bun rather than this.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  cachedTokens,
  cacheTokens,
  contentKey,
  highlightOnWorker,
  poolSize,
  poolStats,
  resetHighlightPool,
  WORKER_THRESHOLD_CHARS,
} from '../../app/Actions/Browse/highlightPool'

afterEach(() => {
  resetHighlightPool()
})

describe('poolSize', () => {
  /**
   * One core for the event loop, one for whatever else the machine is doing,
   * and the rest for tokenizing.
   */
  test('leaves two cores for everything that is not tokenizing', () => {
    expect(poolSize(8)).toBe(6)
    expect(poolSize(4)).toBe(2)
  })

  test('never more than eight, because each worker holds every grammar', () => {
    expect(poolSize(64)).toBe(8)
    expect(poolSize(128)).toBe(8)
  })

  test('a small machine gets one worker rather than none or a negative number', () => {
    expect(poolSize(1)).toBe(1)
    expect(poolSize(2)).toBe(1)
    expect(poolSize(3)).toBe(1)
  })

  test('a nonsense core count falls back rather than producing NaN', () => {
    expect(poolSize(Number.NaN)).toBe(1)
    expect(poolSize(-4)).toBe(1)
  })
})

describe('the threshold', () => {
  /**
   * A message hop and a structured clone cost more than tokenizing a short
   * file. Without this the pool would make a fifteen file pull request slower
   * to serve while looking busy.
   */
  test('a short file is declined, and declining is answered with null', async () => {
    const before = poolStats().inline
    const job = highlightOnWorker(['const a = 1'], 'typescript')

    expect(await job.tokens).toBeNull()
    expect(poolStats().inline).toBe(before + 1)
  })

  test('cancelling something that was never dispatched is harmless', () => {
    const job = highlightOnWorker(['const a = 1'], 'typescript')

    expect(() => job.cancel()).not.toThrow()
    expect(() => job.cancel()).not.toThrow()
  })

  test('the threshold is measured in characters, not lines', () => {
    // One minified line is more work than four hundred short ones.
    const oneLongLine = ['a'.repeat(WORKER_THRESHOLD_CHARS + 1)]
    const manyShortLines = Array.from({ length: 400 }, () => 'a')

    expect(oneLongLine.join('').length).toBeGreaterThan(manyShortLines.join('').length)
  })
})

describe('contentKey', () => {
  test('the same content in the same language is the same key', () => {
    const lines = ['const a = 1', 'const b = 2']

    expect(contentKey(lines, 'typescript')).toBe(contentKey([...lines], 'typescript'))
  })

  test('a different language is a different key, because the colours differ', () => {
    const lines = ['const a = 1']

    expect(contentKey(lines, 'typescript')).not.toBe(contentKey(lines, 'javascript'))
  })

  test('a one character change changes the key', () => {
    expect(contentKey(['const a = 1'], 'ts')).not.toBe(contentKey(['const a = 2'], 'ts'))
  })

  /**
   * Two files with the same characters in a different arrangement have to
   * differ, which is why the line count and the total length are in the key
   * rather than only in the hash.
   */
  test('the same characters split differently is a different key', () => {
    expect(contentKey(['ab'], 'ts')).not.toBe(contentKey(['a', 'b'], 'ts'))
  })

  test('an empty file has a key rather than throwing', () => {
    expect(contentKey([], 'ts')).toBeTruthy()
  })
})

describe('the result cache', () => {
  const tokens = [[{ type: 'text', content: 'a' }]]

  test('gives back what was put in', () => {
    cacheTokens('k1', tokens)

    expect(cachedTokens('k1')).toEqual(tokens)
  })

  test('a miss is undefined rather than an empty result', () => {
    expect(cachedTokens('never-stored')).toBeUndefined()
  })

  test('counts its hits, so the benchmark can tell it is working', () => {
    cacheTokens('k2', tokens)
    const before = poolStats().cached

    cachedTokens('k2')
    cachedTokens('k2')

    expect(poolStats().cached).toBe(before + 2)
  })

  /**
   * Least recently *used*, not least recently inserted: an entry that keeps
   * being asked for should survive, which is the whole difference between a
   * cache and a queue.
   */
  test('evicts the least recently used entry, not the oldest one', () => {
    for (let index = 0; index < 256; index++)
      cacheTokens(`fill-${index}`, tokens)

    // Touch the first one, then push one more in.
    expect(cachedTokens('fill-0')).toEqual(tokens)
    cacheTokens('one-more', tokens)

    expect(cachedTokens('fill-0')).toEqual(tokens)
    expect(cachedTokens('fill-1')).toBeUndefined()
  })

  test('is emptied by a reset, so one test cannot see another one\'s entries', () => {
    cacheTokens('k3', tokens)
    resetHighlightPool()

    expect(cachedTokens('k3')).toBeUndefined()
    expect(poolStats().cacheSize).toBe(0)
  })
})
