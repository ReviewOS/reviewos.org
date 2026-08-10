// Clamping a requested range to a file that exists.
//
// Every case here is arithmetic at an edge, which is where a windowed view goes
// wrong: a range starting past the end renders an empty table, and an empty
// table reads as an empty file rather than as a bad request.

import { describe, expect, test } from 'bun:test'
import { BLOB_WINDOW_LINES, blobWindowFor } from '../../app/Actions/Browse/blobWindow'

describe('blobWindowFor', () => {
  test('no request at all is the first window', () => {
    expect(blobWindowFor(41_988)).toEqual({ from: 1, to: BLOB_WINDOW_LINES })
  })

  test('a file shorter than a window is the whole file', () => {
    expect(blobWindowFor(12)).toEqual({ from: 1, to: 12 })
  })

  test('a window in the middle is exactly the size asked for', () => {
    expect(blobWindowFor(41_988, 2001, 2000)).toEqual({ from: 2001, to: 4000 })
  })

  test('a window running off the end is pulled back so it is still a window', () => {
    // 4,001 would leave a hundred lines on screen with two thousand of room.
    // The reader asked for the end of the file, so they get the end of it.
    expect(blobWindowFor(4100, 4001, 2000)).toEqual({ from: 2101, to: 4100 })
  })

  test('a start past the end lands on the last window rather than on nothing', () => {
    // Not `{ from: 9999, to: 4100 }`, which renders an empty table for a file
    // that plainly has lines in it - and not the last line alone, which reads
    // as a file one line long. A stale link to line 9,999 shows the end.
    expect(blobWindowFor(4100, 9999)).toEqual({ from: 2101, to: 4100 })
  })

  test('a start before the first line is the first line', () => {
    expect(blobWindowFor(500, 0)).toEqual({ from: 1, to: 500 })
    expect(blobWindowFor(500, -20)).toEqual({ from: 1, to: 500 })
  })

  test('an empty file asks for nothing rather than for line one', () => {
    expect(blobWindowFor(0)).toEqual({ from: 1, to: 0 })
  })

  test('a request for more than a window gets a window', () => {
    // The ceiling is the server's, not the caller's: a query string asking for
    // four hundred thousand lines is a request to render the failure mode this
    // exists to prevent.
    expect(blobWindowFor(500_000, 1, 400_000)).toEqual({ from: 1, to: BLOB_WINDOW_LINES })
  })

  test('a fractional or absent count is treated as a whole number of lines', () => {
    expect(blobWindowFor(100, 1.7, 10.2)).toEqual({ from: 1, to: 10 })
  })
})
