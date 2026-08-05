/**
 * When a batch of files goes out.
 *
 * Three conditions, and the reason all three are needed is that each one alone
 * has a shape it handles badly: a count alone stalls a small diff forever, a
 * clock alone schedules a frame per file on a large one, and neither stops
 * parsing from holding the main thread between publishes.
 */

import { describe, expect, test } from 'bun:test'
import { firstBatchSize } from '../../resources/functions/diffviewer'

describe('firstBatchSize', () => {
  test('fills the viewport', () => {
    // 800 pixels of scroll region at 20 pixels a row.
    expect(firstBatchSize(800, 20)).toBe(40)
  })

  test('never smaller than the floor, however short the window', () => {
    expect(firstBatchSize(100, 20)).toBe(25)
    expect(firstBatchSize(1, 20)).toBe(25)
  })

  test('never larger than the ceiling, however tall the window', () => {
    expect(firstBatchSize(10_000, 20)).toBe(96)
  })

  test('rounds up, so a partly visible row still counts', () => {
    expect(firstBatchSize(801, 20)).toBe(41)
  })

  /**
   * A viewport of zero is what a hidden element measures, and a row height of
   * zero is what a missing stylesheet gives. Neither should produce a batch of
   * zero files, which would publish nothing and look like a diff that failed
   * to load.
   */
  test('a measurement that makes no sense falls back rather than dividing by it', () => {
    expect(firstBatchSize(0, 20)).toBe(25)
    expect(firstBatchSize(800, 0)).toBe(25)
    expect(firstBatchSize(Number.NaN, 20)).toBe(25)
    expect(firstBatchSize(-100, 20)).toBe(25)
  })
})
