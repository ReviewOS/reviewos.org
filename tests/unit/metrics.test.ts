// Row counting and list layout, which is what lets the scrollbar mean something
// before anything has been rendered. The cases that matter are the ones where
// split and unified disagree, and the ones where a file has no lines at all.

import { describe, expect, test } from 'bun:test'
import { parseDiff } from '../../app/Actions/Pull/diff'
import {
  countRows,
  DEFAULT_HEIGHT_METRICS,
  estimateFileHeight,
  findIndexAt,
  layoutList,
  visibleRange,
} from '../../app/Actions/Pull/metrics'

/** One hunk: a context line, one removal, two additions, a context line. */
const uneven = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

const rowsOf = (raw: string) => countRows(parseDiff(raw)[0]!)

describe('countRows', () => {
  test('unified counts every line plus a separator per hunk', () => {
    // 4 lines rendered (1 context, 1 removed, 2 added) plus the context line
    // at the end, plus one @@ separator.
    expect(rowsOf(uneven).unified).toBe(6)
  })

  test('split pairs a change block, so it is shorter than unified', () => {
    // separator + context + max(1 removed, 2 added) + context = 5
    expect(rowsOf(uneven).split).toBe(5)
  })

  test('an even change block is the same height in both layouts, minus the pairing', () => {
    const even = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,2 +1,2 @@
-one
+uno
`
    // unified: separator + 1 removed + 1 added = 3
    // split:   separator + max(1, 1)           = 2
    expect(rowsOf(even)).toEqual({ unified: 3, split: 2 })
  })

  test('a pure deletion block is the same in both, since nothing pairs with it', () => {
    const removals = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,3 +1 @@
 keep
-gone
-also gone
`
    expect(rowsOf(removals)).toEqual({ unified: 4, split: 4 })
  })

  test('two change blocks in one hunk each pair separately', () => {
    const twoBlocks = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,5 +1,5 @@
-a
+A
 keep
-b
+B
`
    // unified: separator + 2 + 1 + 2 = 6
    // split:   separator + 1 + 1 + 1 = 4
    expect(rowsOf(twoBlocks)).toEqual({ unified: 6, split: 4 })
  })

  test('several hunks each add their own separator', () => {
    const twoHunks = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1 +1 @@
-a
+A
@@ -10 +10 @@
-b
+B
`
    expect(rowsOf(twoHunks)).toEqual({ unified: 6, split: 4 })
  })

  test('a binary file is one row, not zero', () => {
    const binary = `diff --git a/i.png b/i.png
index 1111111..2222222 100644
Binary files a/i.png and b/i.png differ
`
    expect(rowsOf(binary)).toEqual({ unified: 1, split: 1 })
  })

  test('a mode change with no hunks is one row', () => {
    const mode = `diff --git a/s.sh b/s.sh
old mode 100644
new mode 100755
`
    expect(rowsOf(mode)).toEqual({ unified: 1, split: 1 })
  })
})

describe('estimateFileHeight', () => {
  const rows = { unified: 10, split: 6 }

  test('is the header plus the rows for the chosen layout', () => {
    const { headerHeight, lineHeight } = DEFAULT_HEIGHT_METRICS

    expect(estimateFileHeight(rows)).toBe(headerHeight + 10 * lineHeight)
    expect(estimateFileHeight(rows, { layout: 'split' })).toBe(headerHeight + 6 * lineHeight)
  })

  test('a collapsed file is its header and nothing else', () => {
    expect(estimateFileHeight(rows, { collapsed: true })).toBe(DEFAULT_HEIGHT_METRICS.headerHeight)
  })
})

describe('layoutList', () => {
  const rows = [{ unified: 10, split: 10 }, { unified: 5, split: 5 }, { unified: 1, split: 1 }]

  test('stacks files end to end with a gap between them', () => {
    const { offsets, heights, total } = layoutList(rows)
    const { gap } = DEFAULT_HEIGHT_METRICS

    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(heights[0]! + gap)
    expect(offsets[2]).toBe(heights[0]! + gap + heights[1]! + gap)
    expect(total).toBe(heights[0]! + heights[1]! + heights[2]! + gap * 2)
  })

  test('an empty list has no height at all, not one gap', () => {
    expect(layoutList([])).toEqual({ offsets: [], heights: [], total: 0 })
  })

  test('collapsing a file shortens the list and moves everything below it up', () => {
    const expanded = layoutList(rows)
    const collapsed = layoutList(rows, { collapsedAt: index => index === 0 })

    expect(collapsed.total).toBeLessThan(expanded.total)
    expect(collapsed.offsets[1]).toBeLessThan(expanded.offsets[1]!)
  })
})

describe('findIndexAt', () => {
  const layout = layoutList(Array.from({ length: 1000 }, () => ({ unified: 10, split: 10 })))

  test('finds the file covering a position', () => {
    for (const index of [0, 1, 17, 500, 999]) {
      const top = layout.offsets[index]!
      expect(findIndexAt(layout, top)).toBe(index)
      expect(findIndexAt(layout, top + 1)).toBe(index)
    }
  })

  test('a position above the list lands on the first file', () => {
    expect(findIndexAt(layout, -100)).toBe(0)
  })

  test('a position past the end lands on the last file rather than out of range', () => {
    expect(findIndexAt(layout, layout.total + 10_000)).toBe(999)
  })
})

describe('visibleRange', () => {
  const layout = layoutList(Array.from({ length: 1000 }, () => ({ unified: 10, split: 10 })))
  const fileHeight = layout.heights[0]! + DEFAULT_HEIGHT_METRICS.gap

  test('covers the viewport and no more than the overscan either side', () => {
    const { start, end } = visibleRange(layout, fileHeight * 100, 800, 0)

    expect(start).toBe(100)
    // 800px of viewport over 248px files is four files, and the boundary case
    // is inclusive of the one the bottom edge lands inside.
    expect(end).toBeGreaterThan(start)
    expect(layout.offsets[end - 1]!).toBeLessThan(fileHeight * 100 + 800)
  })

  test('overscan reaches above the viewport but never above the list', () => {
    expect(visibleRange(layout, 0, 800, 1000).start).toBe(0)
    expect(visibleRange(layout, fileHeight * 100, 800, fileHeight).start).toBe(99)
  })

  test('an empty list has an empty range rather than one phantom item', () => {
    expect(visibleRange(layoutList([]), 0, 800, 1000)).toEqual({ start: 0, end: 0 })
  })

  test('a file taller than the viewport still renders', () => {
    const tall = layoutList([{ unified: 100_000, split: 100_000 }])
    const { start, end } = visibleRange(tall, 500_000, 800, 0)

    expect(start).toBe(0)
    expect(end).toBe(1)
  })
})
