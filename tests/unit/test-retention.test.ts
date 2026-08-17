// How long test history is kept, and what keeping it costs.
//
// Execution rows are the one table in this product that grows with how often
// machines run rather than with how much people do. The sweep is not where the
// policy lives - `test_retention_days` is, so an administrator can read it and
// change it - and these are about the two ways a retention sweep goes wrong:
// deleting on a misread setting, and being unable to say what the storage costs
// before somebody turns the collector on.

import { describe, expect, test } from 'bun:test'
import { BYTES_PER_EXECUTION, DEFAULT_RETENTION_DAYS, estimateBytes } from '../../app/Actions/Tests/retention'
import { decideSetting, SETTINGS } from '../../app/Ops/settings'

describe('the policy', () => {
  test('is a setting an administrator can change without a deploy', () => {
    expect(SETTINGS.test_retention_days.type).toBe('number')
    expect(Number(SETTINGS.test_retention_days.fallback)).toBe(DEFAULT_RETENTION_DAYS)

    // Zero is a real answer - an instance that has to prove what its tests did
    // two years ago needs it - so the range has to allow it.
    expect(SETTINGS.test_retention_days.min).toBe(0)
    expect(decideSetting('test_retention_days', '0').ok).toBe(true)
    expect(decideSetting('test_retention_days', '-1').ok).toBe(false)
  })

  test('and says out loud that zero has no ceiling', () => {
    /*
     * The one setting here whose cost is unbounded. Somebody finding that out
     * from a full disk rather than from the description is the failure this
     * sentence exists to prevent.
     */
    expect(SETTINGS.test_retention_days.describes).toContain('0 keeps everything')
  })
})

describe('what it costs to keep', () => {
  test('the estimate is stated in bytes rather than left for somebody to guess', () => {
    /*
     * Two thousand tests, ten pushes a day, ninety days: about 400 megabytes.
     * The point is that the number is answerable *before* turning a collector
     * on, not that it is exact - and that it is small enough to say so, since
     * "this will cost you a gigabyte a year" is what stops somebody assuming
     * it is free and finding out otherwise.
     */
    const bytes = estimateBytes({ tests: 2000, runsPerDay: 10, days: 90 })

    expect(bytes).toBe(2000 * 10 * 90 * BYTES_PER_EXECUTION)
    expect(bytes / 1024 ** 2).toBeGreaterThan(300)
    expect(bytes / 1024 ** 2).toBeLessThan(500)
  })

  test('a suite nobody reports costs nothing', () => {
    expect(estimateBytes({ tests: 0, runsPerDay: 40 })).toBe(0)
  })
})
