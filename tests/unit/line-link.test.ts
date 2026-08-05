// Linking to a line.
//
// The case that decides the format: a path may contain a colon, on every
// filesystem this runs on. Splitting a fragment left to right cuts such a path
// in the wrong place and lands the reader on a file that does not exist.

import { describe, expect, test } from 'bun:test'
import {
  anchorBetween,
  anchorCovers,
  formatLineAnchor,
  type LineAnchor,
  parseLineAnchor,
} from '../../app/Actions/Pull/lineLink'

const anchor = (over: Partial<LineAnchor> = {}): LineAnchor =>
  ({ path: 'src/cart.ts', side: 'right', from: 12, to: 12, ...over })

describe('formatLineAnchor', () => {
  test('a single line', () => {
    expect(formatLineAnchor(anchor())).toBe('#src%2Fcart.ts:R:12')
  })

  test('a range', () => {
    expect(formatLineAnchor(anchor({ from: 12, to: 20 }))).toBe('#src%2Fcart.ts:R:12-20')
  })

  test('the left side is marked as such, because a thread anchors to a side', () => {
    expect(formatLineAnchor(anchor({ side: 'left' }))).toContain(':L:')
  })
})

describe('parseLineAnchor', () => {
  test('reads back what it wrote, for every shape', () => {
    for (const original of [
      anchor(),
      anchor({ from: 3, to: 40 }),
      anchor({ side: 'left' }),
      anchor({ path: 'a/b/c.ts' }),
    ]) {
      expect(parseLineAnchor(formatLineAnchor(original))).toEqual(original)
    }
  })

  test('a path containing a colon survives the round trip', () => {
    // Legal on every filesystem this runs on, and the reason the fragment is
    // parsed from the end rather than the start.
    const original = anchor({ path: 'weird:name.ts' })

    expect(parseLineAnchor(formatLineAnchor(original))).toEqual(original)
  })

  test('a path containing a hash survives it too', () => {
    const original = anchor({ path: 'c#sharp.cs' })

    expect(parseLineAnchor(formatLineAnchor(original))).toEqual(original)
  })

  test('works with or without the leading hash', () => {
    expect(parseLineAnchor('src%2Fa.ts:R:5')).toEqual(anchor({ path: 'src/a.ts', from: 5, to: 5 }))
  })

  test('a fragment that is not ours is refused rather than half-read', () => {
    for (const stranger of ['', '#', '#section-heading', '#a:b:c', '#a:R:', '#a:R:0', '#a:X:5']) {
      expect(parseLineAnchor(stranger)).toBeNull()
    }
  })

  test('an inverted range is refused rather than selecting nothing', () => {
    expect(parseLineAnchor('#a.ts:R:20-12')).toBeNull()
  })

  test('a malformed escape is refused rather than throwing', () => {
    expect(parseLineAnchor('#%E0%A4%A:R:5')).toBeNull()
  })
})

describe('anchorBetween', () => {
  test('covers both lines however they were clicked', () => {
    const low = anchor({ from: 5, to: 5 })
    const high = anchor({ from: 20, to: 20 })

    expect(anchorBetween(low, high)).toMatchObject({ from: 5, to: 20 })
    expect(anchorBetween(high, low)).toMatchObject({ from: 5, to: 20 })
  })

  test('extending upwards works, which is the point of taking the order out', () => {
    expect(anchorBetween(anchor({ from: 30, to: 30 }), anchor({ from: 4, to: 4 })))
      .toMatchObject({ from: 4, to: 30 })
  })
})

describe('anchorCovers', () => {
  const range = anchor({ from: 10, to: 14 })

  test('covers every line in the range and none outside it', () => {
    expect(anchorCovers(range, 'src/cart.ts', 'right', 10)).toBe(true)
    expect(anchorCovers(range, 'src/cart.ts', 'right', 14)).toBe(true)
    expect(anchorCovers(range, 'src/cart.ts', 'right', 9)).toBe(false)
    expect(anchorCovers(range, 'src/cart.ts', 'right', 15)).toBe(false)
  })

  test('the other side of the same line is not covered', () => {
    expect(anchorCovers(range, 'src/cart.ts', 'left', 12)).toBe(false)
  })

  test('the same line in another file is not covered', () => {
    expect(anchorCovers(range, 'other.ts', 'right', 12)).toBe(false)
  })
})
