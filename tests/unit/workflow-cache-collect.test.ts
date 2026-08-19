// Letting go of snapshots, by size and by age.
//
// The rules are a pure function so that the command showing an operator what
// would happen and the job that does it cannot disagree - the usual way a dry
// run lies is by being a second implementation of the real thing. These tests
// are on that function, which is therefore both of them at once.

import { describe, expect, test } from 'bun:test'
import { cachePolicy, DEFAULT_POLICY, prunable } from '../../app/Actions/Workflow/cacheCollect'

const now = Date.parse('2026-08-19T12:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(now - days * 86_400_000).toISOString()
}

function entry(id: number, days: number, sizeBytes = 1024): { id: number, sizeBytes: number, lastUsedAt: string, scope: string } {
  return { id, sizeBytes, lastUsedAt: daysAgo(days), scope: `refs/heads/branch-${id}` }
}

const policy = { maxBytesPerRepository: 10_000, maxIdleDays: 7 }

describe('age', () => {
  test('an entry nobody has restored inside the window goes', () => {
    const verdict = prunable([entry(1, 30), entry(2, 1)], policy, now)

    expect(verdict.remove.map(one => one.id)).toEqual([1])
    expect(verdict.keep.map(one => one.id)).toEqual([2])
    expect(verdict.freed).toBe(1024)
  })

  test('and it goes whatever the total is, because idle is its own rule', () => {
    // Nowhere near the size limit, and still collected: an entry nobody has
    // restored in a week is one whose lockfile has almost certainly moved on.
    const verdict = prunable([entry(1, 8, 1)], policy, now)

    expect(verdict.remove).toHaveLength(1)
  })

  /**
   * A date that will not parse is a row somebody edited or a version that is
   * gone. Deleting on the strength of a value this cannot read is how a bug in
   * a date format becomes a bug in somebody's cache.
   */
  test('a date that cannot be read keeps the entry rather than dropping it', () => {
    const verdict = prunable([{ id: 1, sizeBytes: 1, lastUsedAt: 'the day before yesterday', scope: 'x' }], policy, now)

    expect(verdict.remove).toEqual([])
    expect(verdict.keep).toHaveLength(1)
  })
})

describe('size', () => {
  test('the least recently restored go until what is left fits', () => {
    const verdict = prunable(
      [entry(1, 1, 6000), entry(2, 2, 6000), entry(3, 3, 6000)],
      policy,
      now,
    )

    // 18000 held against a 10000 limit: the two oldest restores go, the most
    // recent stays.
    expect(verdict.remove.map(one => one.id)).toEqual([3, 2])
    expect(verdict.keep.map(one => one.id)).toEqual([1])
  })

  /**
   * Least recently *restored*, not oldest written. An entry a hundred runs a
   * day reach for should outlive one written this morning and never read -
   * what makes a cache worth its disk is being restored.
   */
  test('the entry every run reaches for is the last one standing', () => {
    const busy = { id: 99, sizeBytes: 9000, lastUsedAt: daysAgo(0), scope: 'refs/heads/main' }
    const quiet = { id: 100, sizeBytes: 9000, lastUsedAt: daysAgo(3), scope: 'refs/heads/other' }

    const verdict = prunable([quiet, busy], policy, now)

    expect(verdict.keep.map(one => one.id)).toEqual([99])
  })

  test('nothing is removed when everything fits and nothing is idle', () => {
    const verdict = prunable([entry(1, 1, 100), entry(2, 2, 100)], policy, now)

    expect(verdict.remove).toEqual([])
    expect(verdict.freed).toBe(0)
  })

  test('an empty repository is a quiet answer, not an error', () => {
    expect(prunable([], policy, now)).toEqual({ remove: [], keep: [], freed: 0 })
  })
})

describe('the policy', () => {
  test('is the default until an operator says otherwise', () => {
    expect(cachePolicy({})).toEqual(DEFAULT_POLICY)
  })

  test('and reads what they set', () => {
    const set = cachePolicy({ REVIEWOS_CACHE_MAX_BYTES: '5000', REVIEWOS_CACHE_MAX_IDLE_DAYS: '2' })

    expect(set).toEqual({ maxBytesPerRepository: 5000, maxIdleDays: 2 })
  })

  test('nonsense falls back rather than turning collection off', () => {
    // A zero or a negative would mean "collect everything" or "collect
    // nothing", and both are worse than the default an operator did not
    // deliberately choose.
    expect(cachePolicy({ REVIEWOS_CACHE_MAX_BYTES: '0', REVIEWOS_CACHE_MAX_IDLE_DAYS: 'soon' })).toEqual(DEFAULT_POLICY)
  })
})
