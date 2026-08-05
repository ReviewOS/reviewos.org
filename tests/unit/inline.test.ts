// What changed within a line.
//
// The property everything rests on: a range must cover exactly the characters
// that differ, and slicing the line by the ranges must give back the words a
// reader would point at. A range that is off by one marks the wrong character
// and there is nothing in a screenshot to say so.

import { describe, expect, test } from 'bun:test'
import {
  type CharRange,
  inlineChangedRanges,
  splitWords,
  worthComparing,
} from '../../app/Actions/Pull/inline'

/** The text a set of ranges covers, which is what a reader sees marked. */
function marked(line: string, ranges: readonly CharRange[]): string[] {
  return ranges.map(range => line.slice(range.start, range.end))
}

describe('splitWords', () => {
  test('keeps words, whitespace and punctuation as separate units', () => {
    expect(splitWords('foo(bar)')).toEqual(['foo', '(', 'bar', ')'])
    expect(splitWords('a = 1')).toEqual(['a', ' ', '=', ' ', '1'])
  })

  test('reproduces the line exactly, so ranges over it are trustworthy', () => {
    for (const line of ['const a = 1', '  indented\t(x)', 'ünïcödé + 日本語', '', '   ']) {
      expect(splitWords(line).join('')).toBe(line)
    }
  })
})

describe('inlineChangedRanges', () => {
  test('marks only the word that changed', () => {
    const before = 'const total = subtotal + tax'
    const after = 'const total = subtotal + vat'
    const diff = inlineChangedRanges(before, after)

    expect(marked(before, diff.before)).toEqual(['tax'])
    expect(marked(after, diff.after)).toEqual(['vat'])
  })

  test('marks an insertion on one side only', () => {
    const before = 'round(value)'
    const after = 'round(value, 2)'
    const diff = inlineChangedRanges(before, after)

    expect(diff.before).toEqual([])
    expect(marked(after, diff.after)).toEqual([', 2'])
  })

  test('marks a deletion on one side only', () => {
    const before = 'total(a, b)'
    const after = 'total(a)'
    const diff = inlineChangedRanges(before, after)

    expect(marked(before, diff.before)).toEqual([', b'])
    expect(diff.after).toEqual([])
  })

  test('identical lines mark nothing', () => {
    expect(inlineChangedRanges('same', 'same')).toEqual({ before: [], after: [] })
  })

  test('an empty side marks nothing rather than the whole of the other', () => {
    expect(inlineChangedRanges('', 'added')).toEqual({ before: [], after: [] })
    expect(inlineChangedRanges('removed', '')).toEqual({ before: [], after: [] })
  })

  test('a change at the very start is found', () => {
    const before = 'let x = 1'
    const after = 'const x = 1'

    expect(marked(before, inlineChangedRanges(before, after).before)).toEqual(['let'])
  })

  test('a change at the very end is found', () => {
    const before = 'return a'
    const after = 'return b'

    expect(marked(after, inlineChangedRanges(before, after).after)).toEqual(['b'])
  })

  test('an unchanged space between two changed words stays unmarked', () => {
    // Precise rather than tidy: `a` and `b` changed, the space did not, and
    // marking it would claim an edit that is not there.
    const before = 'call(a b)'
    const after = 'call(x y)'

    expect(marked(before, inlineChangedRanges(before, after).before)).toEqual(['a', 'b'])
  })

  test('a changed run merges into one mark rather than several', () => {
    // Here the whole middle differs, spaces included, and three marks side by
    // side would read as three separate edits.
    const before = 'call(one two three)'
    const after = 'call(alpha)'

    expect(marked(before, inlineChangedRanges(before, after).before)).toEqual(['one two three'])
    expect(marked(after, inlineChangedRanges(before, after).after)).toEqual(['alpha'])
  })

  test('two separate changes stay separate', () => {
    const before = 'f(a, keep, b)'
    const after = 'f(x, keep, y)'
    const diff = inlineChangedRanges(before, after)

    expect(marked(before, diff.before)).toEqual(['a', 'b'])
  })

  test('ranges are in order and never overlap', () => {
    const before = 'one two three four five'
    const after = 'one TWO three FOUR five'
    const { before: ranges } = inlineChangedRanges(before, after)

    for (let index = 1; index < ranges.length; index++)
      expect(ranges[index]!.start).toBeGreaterThanOrEqual(ranges[index - 1]!.end)
  })

  test('ranges stay inside the line', () => {
    const before = 'const value = compute(a, b)'
    const after = 'const result = compute(a, c)'

    for (const [line, ranges] of [
      [before, inlineChangedRanges(before, after).before],
      [after, inlineChangedRanges(before, after).after],
    ] as const) {
      for (const range of ranges) {
        expect(range.start).toBeGreaterThanOrEqual(0)
        expect(range.end).toBeLessThanOrEqual(line.length)
        expect(range.end).toBeGreaterThan(range.start)
      }
    }
  })

  test('indentation-only changes mark the indentation', () => {
    const before = '\tif (a) {'
    const after = '  if (a) {'

    expect(marked(before, inlineChangedRanges(before, after).before)).toEqual(['\t'])
    expect(marked(after, inlineChangedRanges(before, after).after)).toEqual(['  '])
  })

  test('two very long unrelated lines do not run the quadratic step', () => {
    // Marked whole rather than aligned word by word. The assertion that matters
    // is that it returns at all, and quickly.
    const before = Array.from({ length: 900 }, (_, index) => `a${index}`).join(' ')
    const after = Array.from({ length: 900 }, (_, index) => `b${index}`).join(' ')

    const started = performance.now()
    const diff = inlineChangedRanges(before, after)

    expect(performance.now() - started).toBeLessThan(200)
    expect(diff.before).toHaveLength(1)
    expect(diff.after).toHaveLength(1)
  })
})

describe('worthComparing', () => {
  test('a small change to a long line is worth marking', () => {
    const before = 'const total = subtotal + tax'
    const after = 'const total = subtotal + vat'

    expect(worthComparing(before, after, inlineChangedRanges(before, after))).toBe(true)
  })

  test('two unrelated lines are not', () => {
    // A deletion and an addition that happen to be adjacent. Marking nine
    // tenths of both says "everything changed", which hides the lines where
    // something specific did.
    const before = 'import { readFile } from "node:fs"'
    const after = 'export const RETRY_LIMIT = 5'

    expect(worthComparing(before, after, inlineChangedRanges(before, after))).toBe(false)
  })

  test('two empty lines are not worth comparing', () => {
    expect(worthComparing('', '', { before: [], after: [] })).toBe(false)
  })
})
