// The seam between a row index and a line number.
//
// The client windows a file in row indexes, because that is what
// `app/Actions/Pull/window.ts` speaks and the diff viewer uses the same
// arithmetic. The endpoint answers in line numbers, because that is what a
// reader sees in the gutter and what `?from=` carries. One conversion, tested,
// rather than a `+ 1` at four call sites - a window off by one fetches lines
// the spacers do not stand for, and the file scrolls past itself by a line per
// window with nothing about it looking wrong.

import { describe, expect, test } from 'bun:test'
import { linesFor } from '../../resources/functions/blobviewer'

describe('linesFor', () => {
  test('the first window starts at line one', () => {
    expect(linesFor({ from: 0, to: 2000 })).toEqual({ from: 1, count: 2000 })
  })

  test('a window in the middle names the line the reader would see', () => {
    // Rows 2,000 through 3,999 are lines 2,001 through 4,000.
    expect(linesFor({ from: 2000, to: 4000 })).toEqual({ from: 2001, count: 2000 })
  })

  test('a window at the end asks only for what is left', () => {
    expect(linesFor({ from: 11_000, to: 12_000 })).toEqual({ from: 11_001, count: 1000 })
  })

  test('an empty window still asks for a line rather than for nothing', () => {
    // `count=0` would answer with an empty window, which paints spacers for the
    // whole file and shows the reader nothing at all.
    expect(linesFor({ from: 40, to: 40 })).toEqual({ from: 41, count: 1 })
  })
})
