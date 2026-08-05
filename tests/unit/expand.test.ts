// Reading the lines a diff left out.
//
// The arithmetic is the part worth pinning: a gap runs from the line after the
// previous hunk ends to the line before the next one starts, and the two sides
// of a diff drift apart by whatever the hunks before them added or removed. Off
// by one anywhere and the expanded context is the wrong lines, shown with
// confident line numbers.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { contextLinesFrom, gapsIn, oldOffsetAt, splitLines } from '../../app/Actions/Pull/expand'

/** Two hunks, far apart, so there is a gap above, between and below. */
const twoHunks = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 keep
-old
+new
+extra
@@ -40,2 +41,2 @@
 context
-gone
+here
`

const fileOf = (raw: string) => parseDiff(raw)[0]!

describe('splitLines', () => {
  test('a trailing newline does not become a line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
  })

  test('a file with no trailing newline keeps its last line', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })

  test('an empty file has no lines', () => {
    expect(splitLines('')).toEqual([])
  })

  test('a file of one blank line has one', () => {
    expect(splitLines('\n')).toEqual([''])
  })
})

describe('gapsIn', () => {
  test('finds the gap above the first hunk', () => {
    const [first] = gapsIn(fileOf(twoHunks))

    expect(first).toMatchObject({ hunkIndex: 0, from: 1, to: 9, size: 9 })
  })

  test('finds the gap between two hunks', () => {
    const gaps = gapsIn(fileOf(twoHunks))
    const between = gaps.find(gap => gap.hunkIndex === 1)

    // The first hunk covers new lines 10 to 13; the second starts at 41.
    expect(between).toMatchObject({ from: 14, to: 40 })
  })

  test('a hunk starting at line 1 leaves no gap above it', () => {
    const atTop = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-a
+b
`
    expect(gapsIn(fileOf(atTop))).toEqual([])
  })

  test('the gap below the last hunk is only reported when the file length is known', () => {
    const withoutLength = gapsIn(fileOf(twoHunks))
    const withLength = gapsIn(fileOf(twoHunks), 60)

    expect(withoutLength.some(gap => gap.from === 43)).toBe(false)
    expect(withLength.at(-1)).toMatchObject({ from: 43, to: 60 })
  })

  test('a file length inside the last hunk adds no gap below it', () => {
    expect(gapsIn(fileOf(twoHunks), 42).some(gap => gap.hunkIndex === 2)).toBe(false)
  })

  test('gaps are in order and never overlap a hunk', () => {
    const file = fileOf(twoHunks)
    const gaps = gapsIn(file, 60)

    for (const gap of gaps) {
      expect(gap.to).toBeGreaterThanOrEqual(gap.from)
      for (const hunk of file.hunks) {
        const hunkEnd = hunk.newStart + hunk.newLines - 1
        expect(gap.from > hunkEnd || gap.to < hunk.newStart).toBe(true)
      }
    }
  })
})

describe('oldOffsetAt', () => {
  test('is zero before anything has changed length', () => {
    expect(oldOffsetAt(fileOf(twoHunks).hunks[0]!)).toBe(0)
  })

  test('grows by what earlier hunks added', () => {
    // The first hunk turns 3 old lines into 4 new ones, so from the second
    // hunk on, the new side runs one ahead.
    expect(oldOffsetAt(fileOf(twoHunks).hunks[1]!)).toBe(1)
  })
})

describe('contextLinesFrom', () => {
  test('numbers both sides, since expanded lines exist in both', () => {
    const lines = contextLinesFrom(['one', 'two'], 14, 1)

    expect(lines[0]).toMatchObject({ origin: 'context', content: 'one', newLine: 14, oldLine: 13 })
    expect(lines[1]).toMatchObject({ newLine: 15, oldLine: 14 })
  })

  test('with no drift the two sides agree', () => {
    expect(contextLinesFrom(['x'], 5, 0)[0]).toMatchObject({ oldLine: 5, newLine: 5 })
  })

  test('an empty range produces no lines', () => {
    expect(contextLinesFrom([], 1, 0)).toEqual([])
  })
})
