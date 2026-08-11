// Scrolling to a line that is not on screen yet, and may not be rendered at all.
//
// `revealSelection` walks four obstacles - a file still streaming, a collapsed
// file, rows not fetched, and a line inside a gap no one has expanded - by
// retrying rather than predicting. Only the last of those involves a decision,
// and it is this one: which gap hides the line. The rest is element lookup.
//
// The decision is worth testing on its own because getting it wrong has no
// symptom where it happens. Nothing throws and nothing is logged; the loop
// simply never finds a gap, spends its twelve rounds and stops. What the reader
// sees is a link that does nothing.

import { describe, expect, test } from 'bun:test'
import { gapCovering } from '../../resources/functions/diffviewer'

/**
 * A hunk starting at old line 100 / new line 120, so the new side is numbered
 * 20 ahead of the old one. The gap above it hides new lines 90 through 119,
 * which are old lines 70 through 99.
 */
const SHIFTED = [{ from: 90, to: 119, offset: 20 }]

/** Two gaps, so "the first one that covers it" is a real choice. */
const TWO = [
  { from: 10, to: 19, offset: 0 },
  { from: 90, to: 119, offset: 20 },
]

describe('gapCovering', () => {
  test('finds the gap hiding a line on the new side', () => {
    expect(gapCovering(SHIFTED, 'right', 100)).toBe(0)
  })

  test('and the right one when there is more than one', () => {
    expect(gapCovering(TWO, 'right', 15)).toBe(0)
    expect(gapCovering(TWO, 'right', 100)).toBe(1)
  })

  test('says so when no gap hides the line', () => {
    expect(gapCovering(SHIFTED, 'right', 500)).toBe(-1)
    expect(gapCovering([], 'right', 100)).toBe(-1)
  })

  test('includes both ends of the range', () => {
    expect(gapCovering(SHIFTED, 'right', 90)).toBe(0)
    expect(gapCovering(SHIFTED, 'right', 119)).toBe(0)
    expect(gapCovering(SHIFTED, 'right', 89)).toBe(-1)
    expect(gapCovering(SHIFTED, 'right', 120)).toBe(-1)
  })

  /*
   * The case the whole helper exists for.
   *
   * A gap's range is in the new side's numbering. Old line 80 is new line 100,
   * which is inside this gap - but 80 on its own is below `from`, so comparing
   * the raw number finds nothing and a removed line inside a collapsed region
   * is unreachable by link. Deleted lines only *have* an old number, so this is
   * not an edge case: it is half of what a reviewer follows a link to.
   */
  test('moves an old-side line into the gap\'s numbering before comparing', () => {
    expect(gapCovering(SHIFTED, 'left', 80)).toBe(0)
  })

  test('and an old-side line outside the gap is still outside it', () => {
    // Old 69 is new 89, one before the gap starts; old 100 is new 120, one past.
    expect(gapCovering(SHIFTED, 'left', 69)).toBe(-1)
    expect(gapCovering(SHIFTED, 'left', 100)).toBe(-1)
  })

  test('with no shift the two sides agree', () => {
    const flat = [{ from: 10, to: 19, offset: 0 }]

    expect(gapCovering(flat, 'left', 15)).toBe(0)
    expect(gapCovering(flat, 'right', 15)).toBe(0)
  })

  // The control's dataset is read with `Number()`, which answers NaN for an
  // attribute that is missing or malformed. A NaN range must not swallow a
  // line: `NaN >= x` is false, so it cannot match, but a gap after it still has
  // to be reachable.
  test('skips a control whose range did not parse, and keeps looking', () => {
    const gaps = [
      { from: Number.NaN, to: Number.NaN, offset: 0 },
      { from: 90, to: 119, offset: 20 },
    ]

    expect(gapCovering(gaps, 'right', 100)).toBe(1)
  })

  test('and treats a missing offset as no shift rather than as NaN', () => {
    const gaps = [{ from: 90, to: 119, offset: Number.NaN }]

    // Without the guard this compares `100 + NaN`, which matches nothing.
    expect(gapCovering(gaps, 'left', 100)).toBe(0)
  })
})
