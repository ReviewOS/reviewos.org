// The decisions a virtualized list makes, tested without a DOM.
//
// These are the bugs that do not show up in a screenshot: a file remounted
// every frame, an anchor that drifts, a window that misses the file the reader
// is looking at, a collapsed file still scrolled three hundred pixels into.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_HEIGHT_METRICS, layoutList } from '../../app/Actions/Pull/metrics'
import {
  appendPositions,
  captureAnchor,
  type ListItem,
  measuredLayout,
  planFrame,
  planMounts,
  positionsByKey,
  reconcileList,
  restoreAnchor,
  MAX_SCROLL_DEVICE_PIXELS,
  scrollBehaviourFor,
  scrollCeiling,
  scrollSpace,
  scrollTargetFor,
  snapToDevicePixel,
  type ViewportFile,
} from '../../app/Actions/Pull/viewport'

const rows = (count: number) => ({ unified: count, split: count })

function item(id: string, options: Partial<ListItem> = {}): ListItem {
  return { id, version: 0, rows: rows(10), collapsed: false, ...options }
}

function items(...ids: string[]): ListItem[] {
  return ids.map(id => item(id))
}

function files(count: number, lines = 10): ViewportFile[] {
  return Array.from({ length: count }, () => ({ rows: rows(lines), collapsed: false }))
}

describe('planMounts', () => {
  test('mounts a fresh range', () => {
    const plan = planMounts(new Set(), 2, 5)

    expect(plan.mount).toEqual([2, 3, 4])
    expect(plan.unmount).toEqual([])
    expect([...plan.next]).toEqual([2, 3, 4])
  })

  test('leaves a file that is already mounted and still in range alone', () => {
    // The property the whole design rests on. Remounting would throw away the
    // measured height, the scroll position inside a wide file, and any comment
    // box the reader has open, sixty times a second.
    const plan = planMounts(new Set([2, 3, 4]), 3, 6)

    expect(plan.mount).toEqual([5])
    expect(plan.unmount).toEqual([2])
  })

  test('releases everything when the range moves off entirely', () => {
    const plan = planMounts(new Set([0, 1, 2]), 100, 102)

    expect(plan.mount).toEqual([100, 101])
    expect(plan.unmount).toEqual([0, 1, 2])
  })

  test('an unchanged range asks for no work at all', () => {
    const plan = planMounts(new Set([4, 5, 6]), 4, 7)

    expect(plan.mount).toEqual([])
    expect(plan.unmount).toEqual([])
  })

  test('unmounts in ascending order, so the caller walks the DOM one way', () => {
    const plan = planMounts(new Set([9, 2, 7, 4]), 100, 101)

    expect(plan.unmount).toEqual([2, 4, 7, 9])
  })
})

describe('captureAnchor and restoreAnchor', () => {
  const layout = layoutList(Array.from({ length: 100 }, () => rows(10)))
  const fileStride = layout.heights[0]! + DEFAULT_HEIGHT_METRICS.gap

  test('a captured anchor restores to exactly where it was taken', () => {
    for (const scrollTop of [0, 17, fileStride * 40, fileStride * 40 + 63]) {
      const anchor = captureAnchor(layout, scrollTop)
      expect(restoreAnchor(layout, anchor)).toBe(scrollTop)
    }
  })

  test('the reader stays put when a file above them grows', () => {
    const before = layoutList(Array.from({ length: 100 }, () => rows(10)))
    const anchor = captureAnchor(before, fileStride * 40 + 20)

    // File 5 turns out to be four times taller than estimated.
    const grown = layoutList(Array.from({ length: 100 }, (_, index) => rows(index === 5 ? 40 : 10)))
    const restored = restoreAnchor(grown, anchor)

    // The anchored file sits at the same distance from the top of the viewport,
    // even though everything moved down.
    expect(restored - grown.offsets[40]!).toBe(20)
    expect(restored).toBeGreaterThan(fileStride * 40 + 20)
  })

  test('an offset deeper than the file survives the file collapsing', () => {
    const expanded = layoutList([rows(400), rows(10)])
    const anchor = captureAnchor(expanded, 300)
    expect(anchor).toMatchObject({ index: 0, offset: 300 })

    const collapsed = layoutList([rows(400), rows(10)], { collapsedAt: index => index === 0 })
    const restored = restoreAnchor(collapsed, anchor)

    // Clamped to the collapsed height rather than carrying 300px and jumping
    // the reader past the file that collapsed and several after it.
    expect(restored).toBeLessThanOrEqual(collapsed.heights[0]!)
  })

  test('an anchor on a file that no longer exists lands on the last one', () => {
    const anchor = { index: 500, offset: 10 }
    const shrunk = layoutList([rows(10), rows(10)])

    expect(restoreAnchor(shrunk, anchor)).toBeLessThanOrEqual(shrunk.total)
  })

  test('an empty list has no anchor and restores to the top', () => {
    expect(captureAnchor(layoutList([]), 0)).toBeNull()
    expect(restoreAnchor(layoutList([]), null)).toBe(0)
  })
})

describe('snapToDevicePixel', () => {
  test('leaves whole pixels alone at 1x', () => {
    expect(snapToDevicePixel(120, 1)).toBe(120)
  })

  test('snaps to the grid the browser actually stores scrollTop on', () => {
    expect(snapToDevicePixel(120.3, 2)).toBe(120.5)
    expect(snapToDevicePixel(100.7, 1.25)).toBe(100.8)
  })

  test('a nonsense ratio falls back to 1 rather than producing NaN', () => {
    expect(snapToDevicePixel(120.4, 0)).toBe(120)
  })
})

describe('measuredLayout', () => {
  test('uses estimates until something has been measured', () => {
    const estimated = layoutList([rows(10), rows(10)])

    expect(measuredLayout(files(2))).toEqual(estimated)
  })

  test('a measured height replaces the estimate for that file and moves the rest', () => {
    const list = files(3)
    list[0]!.measured = 1000

    const layout = measuredLayout(list)

    expect(layout.heights[0]).toBe(1000)
    expect(layout.offsets[1]).toBe(1000 + DEFAULT_HEIGHT_METRICS.gap)
  })

  /**
   * A collapsed file used to keep its estimate however tall it measured,
   * because collapsing hid the rows rather than dropping them, so what it
   * measured was still the open height. A collapsed file is now rendered as its
   * header alone, so the measurement is the header - and a measured header
   * beats a guessed one. The caller clears the measurement when the fold state
   * changes, which is what keeps this honest.
   */
  test('a measured height wins whether the file is collapsed or not', () => {
    const list = files(2)
    list[0]!.measured = 61
    list[0]!.collapsed = true

    expect(measuredLayout(list).heights[0]).toBe(61)
  })

  test('a collapsed file with nothing measured is its estimated header', () => {
    const list = files(2)
    list[0]!.collapsed = true

    expect(measuredLayout(list).heights[0]).toBe(DEFAULT_HEIGHT_METRICS.headerHeight)
  })

  test('switching layout re-lays-out, because split and unified are different heights', () => {
    const list: ViewportFile[] = [{ rows: { unified: 20, split: 12 }, collapsed: false }]

    expect(measuredLayout(list, { layout: 'unified' }).total)
      .toBeGreaterThan(measuredLayout(list, { layout: 'split' }).total)
  })

  test('an empty list has no height', () => {
    expect(measuredLayout([]).total).toBe(0)
  })
})

describe('planFrame', () => {
  test('mounts the files covering the viewport plus the overscan', () => {
    const list = files(1000)
    const { plan } = planFrame(list, new Set(), { scrollTop: 0, height: 800 }, { overscan: 0 })

    expect(plan.mount[0]).toBe(0)
    expect(plan.mount.length).toBeGreaterThan(0)
    expect(plan.mount.length).toBeLessThan(10)
  })

  test('scrolling by one file mounts one and releases one', () => {
    const list = files(1000)
    const viewport = { scrollTop: 0, height: 800 }

    const first = planFrame(list, new Set(), viewport, { overscan: 0 })
    const stride = first.layout.heights[0]! + DEFAULT_HEIGHT_METRICS.gap

    const second = planFrame(list, first.plan.next, { ...viewport, scrollTop: stride }, { overscan: 0 })

    expect(second.plan.unmount).toEqual([0])
    expect(second.plan.mount.length).toBeLessThanOrEqual(2)
  })

  test('reports no scroll correction when there is no anchor', () => {
    const { scrollTop } = planFrame(files(10), new Set(), { scrollTop: 100, height: 800 })

    expect(scrollTop).toBeUndefined()
  })

  test('corrects the scroll position when an anchored file above the reader grows', () => {
    const list = files(100)
    const before = measuredLayout(list)
    const anchor = captureAnchor(before, before.offsets[40]! + 20)

    list[5]!.measured = 4000

    const { scrollTop } = planFrame(list, new Set(), { scrollTop: before.offsets[40]! + 20, height: 800 }, { anchor })

    expect(scrollTop).toBeDefined()
    expect(scrollTop!).toBeGreaterThan(before.offsets[40]! + 20)
  })

  test('does not report a correction for a sub-pixel difference', () => {
    // Otherwise every frame writes scrollTop back, which fights the reader's
    // own scrolling and reads as the list sticking.
    const list = files(100)
    const layout = measuredLayout(list)
    const anchor = captureAnchor(layout, layout.offsets[10]!)

    const { scrollTop } = planFrame(list, new Set(), { scrollTop: layout.offsets[10]! + 0.2, height: 800 }, { anchor })

    expect(scrollTop).toBeUndefined()
  })

  test('an empty list plans nothing rather than one phantom mount', () => {
    const { plan, layout } = planFrame([], new Set(), { scrollTop: 0, height: 800 })

    expect(plan.mount).toEqual([])
    expect(layout.total).toBe(0)
  })

  test('a file taller than the viewport is still mounted', () => {
    const list: ViewportFile[] = [{ rows: rows(100_000), collapsed: false }]
    const { plan } = planFrame(list, new Set(), { scrollTop: 500_000, height: 800 }, { overscan: 0 })

    expect(plan.mount).toEqual([0])
  })

  test('appending files while streaming does not disturb what is mounted', () => {
    const list = files(20)
    const first = planFrame(list, new Set(), { scrollTop: 0, height: 800 }, { overscan: 0 })

    const grown = [...list, ...files(1000)]
    const second = planFrame(grown, first.plan.next, { scrollTop: 0, height: 800 }, { overscan: 0 })

    expect(second.plan.unmount).toEqual([])
  })
})

/**
 * Where the list has to scroll to bring something into view.
 *
 * Pure, and clamped here rather than in the caller: a scroll to the last file
 * of a diff otherwise asks for a position past the end, the browser lands
 * somewhere else, and the result is the "it scrolled nearly to the right place"
 * bug that is impossible to reproduce on a small diff.
 */
describe('scrollTargetFor', () => {
  // Ten files, each 100 tall, 8 apart: tops at 0, 108, 216, ...
  const layout = measuredLayout(
    Array.from({ length: 10 }, () => ({ rows: { unified: 2, split: 2 }, collapsed: false, measured: 100 })),
  )

  test('start puts the file at the top of the viewport', () => {
    expect(scrollTargetFor(layout, 500, { index: 2 })).toBe(216)
  })

  test('center leaves half the spare room above it', () => {
    expect(scrollTargetFor(layout, 500, { index: 5, alignment: 'center' })).toBe(540 - 200)
  })

  test('end brings its last line to the bottom', () => {
    expect(scrollTargetFor(layout, 500, { index: 5, alignment: 'end' })).toBe(540 + 100 - 500)
  })

  test('never asks for a position past the end of the list', () => {
    const furthest = layout.total - 500

    expect(scrollTargetFor(layout, 500, { index: 9 })).toBe(furthest)
    expect(scrollTargetFor(layout, 500, { index: 9, alignment: 'end' })).toBe(furthest)
  })

  test('never asks for a negative position', () => {
    expect(scrollTargetFor(layout, 500, { index: 0, alignment: 'center' })).toBe(0)
    expect(scrollTargetFor(layout, 500, { index: 0, headerOffset: 40 })).toBe(0)
  })

  test('an offset scrolls to a line within the file rather than to the file', () => {
    expect(scrollTargetFor(layout, 500, { index: 3, offset: 40 })).toBe(324 + 40)
  })

  test('a header offset leaves room for the header sitting over the target', () => {
    expect(scrollTargetFor(layout, 500, { index: 3, headerOffset: 20 })).toBe(324 - 20)
  })

  test('a file that does not exist has no target rather than a wrong one', () => {
    expect(scrollTargetFor(layout, 500, { index: 99 })).toBeNull()
    expect(scrollTargetFor(layout, 500, { index: -1 })).toBeNull()
  })
})

describe('scrollBehaviourFor', () => {
  test('smooth when asked for and the reader has not objected', () => {
    expect(scrollBehaviourFor(true, false)).toBe('smooth')
  })

  /**
   * Not a preference about decoration. A smooth scroll of several thousand
   * pixels is nausea for some readers, and this is the only scroll in the
   * product that can be that long.
   */
  test('never smooth when the reader has asked for less motion', () => {
    expect(scrollBehaviourFor(true, true)).toBe('auto')
  })

  test('and jumping stays jumping either way', () => {
    expect(scrollBehaviourFor(false, false)).toBe('auto')
    expect(scrollBehaviourFor(false, true)).toBe('auto')
  })
})

/**
 * The shapes that catch virtualizer bugs specifically.
 *
 * None of these is visible in a screenshot and every one of them is a real
 * report from somebody using a list: a file that remounts on every frame, a
 * reader thrown up the page by something collapsing above them, an item that
 * changes identity while the stream is still arriving.
 */
describe('the shapes that catch virtualizer bugs', () => {
  /**
   * React's strict mode mounts, unmounts and mounts again to find effects that
   * are not idempotent. Whatever the framework, the property is the same: two
   * plans over the same state must ask for the same thing, and the second must
   * ask for no work.
   */
  test('planning twice over the same state asks for no work the second time', () => {
    const list = files(50)
    const viewport = { scrollTop: 400, height: 800 }

    const first = planFrame(list, new Set(), viewport)
    const second = planFrame(list, first.plan.next, viewport)

    expect(second.plan.mount).toEqual([])
    expect(second.plan.unmount).toEqual([])
    expect([...second.plan.next]).toEqual([...first.plan.next])
  })

  /**
   * A reconcile that receives new files mid-render must not disturb what is
   * already mounted. Appending is the only thing a manifest stream does, and a
   * plan that remounted everything on each batch would throw away every
   * measured height sixty times a second.
   */
  test('files arriving mid-stream do not disturb what is mounted', () => {
    const viewport = { scrollTop: 0, height: 800 }
    const first = planFrame(files(20), new Set(), viewport)

    // The next batch lands: twenty more files, appended.
    const second = planFrame(files(40), first.plan.next, viewport)

    expect(second.plan.unmount).toEqual([])
    for (const index of first.plan.next)
      expect(second.plan.next.has(index)).toBe(true)
  })

  test('an item removed while off screen is not asked to unmount twice', () => {
    // Mounted 0..2, then the list shrinks to one file.
    const plan = planMounts(new Set([0, 1, 2]), 0, 1)

    expect(plan.unmount).toEqual([1, 2])
    expect(planMounts(plan.next, 0, 1).unmount).toEqual([])
  })

  /**
   * A rename can arrive late in a stream, which renumbers the file. The list is
   * addressed by position, so the guarantee that matters is that a shorter list
   * never leaves the reader scrolled past its end.
   */
  test('a list that shrinks under the reader lands them inside it', () => {
    const long = layoutList(Array.from({ length: 100 }, () => rows(10)))
    const anchor = captureAnchor(long, long.offsets[90]! + 30)

    const short = layoutList(Array.from({ length: 5 }, () => rows(10)))
    const restored = restoreAnchor(short, anchor)

    expect(restored).toBeGreaterThanOrEqual(0)
    expect(restored).toBeLessThanOrEqual(short.total)
  })

  /**
   * The one that is most obviously wrong when it breaks: a file above the
   * reader collapses, everything below it moves up by its height, and the
   * passage being read jumps off the screen unless the anchor holds.
   */
  test('collapsing a file above the reader leaves them on the same line', () => {
    const before = layoutList(Array.from({ length: 20 }, () => rows(40)))
    const readingAt = before.offsets[10]! + 55
    const anchor = captureAnchor(before, readingAt)

    const after = layoutList(Array.from({ length: 20 }, () => rows(40)), {
      collapsedAt: index => index === 3,
    })
    const restored = restoreAnchor(after, anchor)

    // Same distance into the same file, even though everything moved up.
    expect(restored - after.offsets[10]!).toBe(55)
    expect(restored).toBeLessThan(readingAt)
  })

  test('collapsing a file below the reader does not move them at all', () => {
    const before = layoutList(Array.from({ length: 20 }, () => rows(40)))
    const readingAt = before.offsets[10]! + 55
    const anchor = captureAnchor(before, readingAt)

    const after = layoutList(Array.from({ length: 20 }, () => rows(40)), {
      collapsedAt: index => index === 17,
    })

    expect(restoreAnchor(after, anchor)).toBe(readingAt)
  })

  /**
   * The scrollbar must not lie. Estimates are what a forty thousand file
   * compare is laid out from, so an estimate that is wildly off makes the
   * scrollbar's thumb the wrong size and the reader's drag land somewhere else.
   */
  test('an estimate is within a sane distance of what a file measures', () => {
    const list = files(1, 40)
    const estimated = measuredLayout(list).heights[0]!

    // A file of forty lines, measured at the line height the metrics assume
    // plus a header. The estimate should be the same order, not the same to
    // the pixel: wrapping and injected rows are exactly what it cannot know.
    list[0]!.measured = 40 * DEFAULT_HEIGHT_METRICS.lineHeight + DEFAULT_HEIGHT_METRICS.headerHeight
    const measured = measuredLayout(list).heights[0]!

    expect(Math.abs(measured - estimated) / measured).toBeLessThan(0.1)
  })
})

/**
 * The reader stays where they were, whatever moved.
 *
 * Anchoring is the difference between a list that changes under somebody and a
 * list that changes around them. Each case below is a real thing the viewer
 * does - and each is a different way for everything below the reader to move.
 */
describe('scroll anchoring across every change that moves things', () => {
  const twenty = () => Array.from({ length: 20 }, () => rows(40))
  const readingIn = 10
  const readingOffset = 55

  function anchoredAt(layout: ReturnType<typeof layoutList>) {
    return captureAnchor(layout, layout.offsets[readingIn]! + readingOffset)
  }

  test('a file above collapsing', () => {
    const before = layoutList(twenty())
    const after = layoutList(twenty(), { collapsedAt: index => index === 3 })

    expect(restoreAnchor(after, anchoredAt(before)) - after.offsets[readingIn]!).toBe(readingOffset)
  })

  test('a file above expanding', () => {
    const before = layoutList(twenty(), { collapsedAt: index => index === 3 })
    const after = layoutList(twenty())

    expect(restoreAnchor(after, anchoredAt(before)) - after.offsets[readingIn]!).toBe(readingOffset)
  })

  /**
   * Turning wrap on makes every line potentially two, so every measured height
   * is wrong at once - which is the largest change the list ever makes.
   */
  test('word wrap turning on, which invalidates every measurement at once', () => {
    const list = twenty().map(rowCounts => ({ rows: rowCounts, collapsed: false, measured: 800 }))
    const before = measuredLayout(list)
    const anchor = captureAnchor(before, before.offsets[readingIn]! + readingOffset)

    // Wrapped: every file is taller, and the viewer drops its measurements.
    const after = measuredLayout(list.map(file => ({ ...file, measured: 1_400 })))

    expect(restoreAnchor(after, anchor) - after.offsets[readingIn]!).toBe(readingOffset)
  })

  /**
   * A theme change does not move anything by itself, so the property is that
   * the reader does not move either - a no-op that anchors to a no-op.
   */
  test('a theme change, which moves nothing and must therefore move nobody', () => {
    const layout = measuredLayout(twenty().map(rowCounts => ({ rows: rowCounts, collapsed: false })))
    const at = layout.offsets[readingIn]! + readingOffset

    expect(restoreAnchor(layout, captureAnchor(layout, at))).toBe(at)
  })

  test('a layout switch, where every file is a different height', () => {
    const list = Array.from({ length: 20 }, () => ({ rows: { unified: 40, split: 26 }, collapsed: false }))
    const before = measuredLayout(list, { layout: 'unified' })
    const anchor = captureAnchor(before, before.offsets[readingIn]! + readingOffset)
    const after = measuredLayout(list, { layout: 'split' })

    // The offset within the file is kept, clamped to the file's new height -
    // which is what stops a reader ending up past the end of a shorter file.
    const restored = restoreAnchor(after, anchor)
    expect(restored).toBeGreaterThanOrEqual(after.offsets[readingIn]!)
    expect(restored).toBeLessThanOrEqual(after.offsets[readingIn]! + after.heights[readingIn]!)
  })
})

/**
 * A list that changes shape, rather than one that only grows.
 *
 * Every test above addresses the list by position, which is what a frame does
 * and is right for a frame. These are about the other event: the set of items
 * changing under a reader who is in the middle of it. Appending cannot show any
 * of this - and appending is all a manifest stream does, which is how the list
 * got this far without identity - but a re-fetch is not an append. "Since I
 * last looked" answers with a different set, a push mid-review changes which
 * files exist, and a filter shows a subset.
 */
describe('reconcileList', () => {
  test('appending disturbs nothing that is already mounted', () => {
    const before = items('a', 'b')
    const after = items('a', 'b', 'c', 'd')

    const plan = reconcileList(before, after, { mounted: new Set([0, 1]) })

    expect(plan.keep).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }])
    expect(plan.rerender).toEqual([])
    expect(plan.release).toEqual([])
    expect([...plan.mounted]).toEqual([0, 1])
  })

  /**
   * The bug identity exists for. Inserting at the top renumbers everything
   * below, so a list addressed by position hands `b`'s mounted element to `a`
   * and shows one file's rows under another file's header - a correct render of
   * the wrong thing, which no screenshot flags.
   */
  test('an item inserted above keeps every mounted host with its own item', () => {
    const before = items('a', 'b', 'c')
    const after = items('new', 'a', 'b', 'c')

    const plan = reconcileList(before, after, { mounted: new Set([0, 1, 2]) })

    expect(plan.keep).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }])
    expect(plan.release).toEqual([])
    expect([...plan.mounted]).toEqual([1, 2, 3])
  })

  test('and carries their measured heights with them', () => {
    const before = [item('a', { measured: 400 }), item('b', { measured: 250 })]
    const after = items('new', 'a', 'b')

    const plan = reconcileList(before, after)

    expect(plan.measured).toEqual([undefined, 400, 250])
  })

  /**
   * The other half: same item, different content. What was measured was the
   * other content, so the measurement goes with it - an estimate at least knows
   * the new row count, and a stale height is a scrollbar that lies.
   */
  test('a version bump re-renders in place and drops the stale measurement', () => {
    const before = [item('a', { measured: 400 }), item('b', { measured: 250 })]
    const after = [item('a', { version: 1, measured: undefined }), item('b', { measured: 250 })]

    const plan = reconcileList(before, after, { mounted: new Set([0, 1]) })

    expect(plan.rerender).toEqual([{ from: 0, to: 0 }])
    expect(plan.keep).toEqual([{ from: 1, to: 1 }])
    expect(plan.measured).toEqual([undefined, 250])
  })

  test('an item that is gone releases its host, and one that arrives is left to the frame', () => {
    const before = items('a', 'b', 'c')
    const after = items('a', 'c', 'd')

    const plan = reconcileList(before, after, { mounted: new Set([0, 1, 2]) })

    // `b` is gone: its host goes back to the pool. `c` moved up. `d` is new and
    // mounts only if the next frame decides it is in range - reconciling is not
    // the place to decide what is on screen.
    expect(plan.release).toEqual([1])
    expect(plan.keep).toEqual([{ from: 0, to: 0 }, { from: 2, to: 1 }])
    expect([...plan.mounted]).toEqual([0, 1])
  })

  test('an item that moved but was never mounted asks for nothing', () => {
    const plan = reconcileList(items('a', 'b'), items('b', 'a'), { mounted: new Set() })

    expect(plan.keep).toEqual([])
    expect(plan.rerender).toEqual([])
    expect(plan.release).toEqual([])
  })

  /**
   * The reader's place is in a *file*, not at a scroll offset. Ten files
   * arriving above them moves that file down the list, and an anchor that
   * stayed on index 3 would land them in a file they have never seen.
   */
  test('the anchor follows the item the reader was in', () => {
    const before = items('a', 'b', 'c')
    const after = items('x', 'y', 'a', 'b', 'c')

    const plan = reconcileList(before, after, { anchor: { index: 1, offset: 120 } })

    expect(plan.anchor).toEqual({ index: 3, offset: 120 })
  })

  test('and is dropped, rather than guessed at, when that item is gone', () => {
    const plan = reconcileList(items('a', 'b'), items('a'), { anchor: { index: 1, offset: 120 } })

    // Keeping index 1 would land the reader in whatever moved into the slot,
    // which reads as the page having jumped on its own.
    expect(plan.anchor).toBeNull()
  })

  test('a list replaced entirely keeps nothing and releases everything', () => {
    const plan = reconcileList(items('a', 'b'), items('c', 'd'), { mounted: new Set([0, 1]) })

    expect(plan.keep).toEqual([])
    expect(plan.release).toEqual([0, 1])
    expect([...plan.mounted]).toEqual([])
  })

  test('an emptied list is a plan, not a crash', () => {
    const plan = reconcileList(items('a', 'b'), [], { mounted: new Set([0, 1]), anchor: { index: 0, offset: 10 } })

    expect(plan.release).toEqual([0, 1])
    expect(plan.measured).toEqual([])
    expect(plan.anchor).toBeNull()
  })

  test('a duplicate id resolves to the first, and the second is simply new', () => {
    const before = [item('a', { measured: 300 })]
    const after = [item('a'), item('a')]

    const plan = reconcileList(before, after, { mounted: new Set([0]) })

    expect(plan.keep).toEqual([{ from: 0, to: 0 }])
    expect(plan.measured).toEqual([300, undefined])
  })

  test('reconciling twice over the same list asks for no work the second time', () => {
    const list = items('a', 'b', 'c')
    const first = reconcileList(list, list, { mounted: new Set([0, 1, 2]) })
    const second = reconcileList(list, list, { mounted: first.mounted })

    expect(second.rerender).toEqual([])
    expect(second.release).toEqual([])
    expect(second.keep).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }, { from: 2, to: 2 }])
  })
})

/**
 * The diff's numbering, and the list's.
 *
 * Everything outside the viewer addresses a file by its index in the whole diff
 * - the number the manifest, the row fetches and the file tree all use - and
 * the list holds positions. They are the same number only while the list is the
 * whole diff in order, which stops being true the moment anything shows a
 * subset.
 */
describe('positionsByKey', () => {
  test('the whole diff in order is the identity, which is why nothing noticed', () => {
    expect([...positionsByKey([0, 1, 2, 3]).entries()]).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])
  })

  test('a subset maps the diff\'s numbers onto the positions it kept', () => {
    // Files 2, 5 and 9 of a diff survive a filter: three positions, and the
    // numbers the rest of the product still calls them by.
    const positions = positionsByKey([2, 5, 9])

    expect(positions.get(2)).toBe(0)
    expect(positions.get(5)).toBe(1)
    expect(positions.get(9)).toBe(2)
  })

  test('a file the list is not showing has no position at all', () => {
    // Undefined rather than 0, which is a real file and the one at the top.
    expect(positionsByKey([2, 5, 9]).get(3)).toBeUndefined()
  })

  test('an empty list maps nothing', () => {
    expect(positionsByKey([]).size).toBe(0)
  })

  test('a repeated key resolves to the later position, as a list would', () => {
    expect(positionsByKey([4, 4]).get(4)).toBe(1)
  })
})

/**
 * The filter, as the screen actually performs it.
 *
 * "Changed since you looked" used to narrow the sidebar and leave the diff
 * whole: the list said "3 of 43" while the reader scrolled past forty unchanged
 * files to reach the three that moved. Narrowing both halves is a list that
 * changes shape under somebody in the middle of reading it, which is the case
 * every position-addressed list gets wrong.
 */
describe('narrowing the diff to what changed, and putting it back', () => {
  const whole = Array.from({ length: 43 }, (_, index) => item(`file-${index}.ts`, { measured: 200 + index }))
  const changed = new Set(['file-7.ts', 'file-19.ts', 'file-31.ts'])

  test('the files that survive keep their element and their measured height', () => {
    const narrowed = whole.filter(file => changed.has(file.id))

    // The reader is inside file 19, with 7, 19 and 31 mounted around them.
    const plan = reconcileList(whole, narrowed, {
      mounted: new Set([7, 19, 31]),
      anchor: { index: 19, offset: 140 },
    })

    expect(plan.keep).toEqual([{ from: 7, to: 0 }, { from: 19, to: 1 }, { from: 31, to: 2 }])
    expect(plan.release).toEqual([])
    expect(plan.measured).toEqual([207, 219, 231])

    // And they are still reading file 19, which is now the second row rather
    // than the twentieth.
    expect(plan.anchor).toEqual({ index: 1, offset: 140 })
  })

  test('everything else is released rather than left in the document', () => {
    const narrowed = whole.filter(file => changed.has(file.id))
    const plan = reconcileList(whole, narrowed, { mounted: new Set([4, 5, 6, 7]) })

    expect(plan.release).toEqual([4, 5, 6])
    expect([...plan.mounted]).toEqual([0])
  })

  test('turning it off restores the whole diff without disturbing what is on screen', () => {
    const narrowed = whole.filter(file => changed.has(file.id))
    const back = reconcileList(narrowed, whole, {
      mounted: new Set([0, 1, 2]),
      anchor: { index: 1, offset: 140 },
    })

    expect(back.keep).toEqual([{ from: 0, to: 7 }, { from: 1, to: 19 }, { from: 2, to: 31 }])
    expect(back.release).toEqual([])
    expect(back.anchor).toEqual({ index: 19, offset: 140 })
  })

  test('a file arriving while narrowed does not appear until the filter is lifted', () => {
    // The manifest is still streaming. The new file is not in the narrowed
    // list, so nothing about the mounted set changes.
    const narrowed = whole.filter(file => changed.has(file.id))
    const plan = reconcileList(narrowed, narrowed, { mounted: new Set([0, 1, 2]) })

    expect(plan.rerender).toEqual([])
    expect(plan.release).toEqual([])
    expect(plan.keep.length).toBe(3)
  })
})

/**
 * A diff taller than a browser will scroll.
 *
 * Found on Linux `v6.0...v7.0`, and it is not a slow path: at 27,408 of its
 * 78,985 files the viewer asked for a content element 40,300,800px tall and
 * Chrome gave it 33,554,428px - 2^25 minus four, the most a layout box may be.
 * Everything past that had no scroll position mapping to it, so roughly two
 * thirds of the diff could not be reached by scrolling at all. The reader got
 * to the end of the scrollbar and was looking at empty space.
 *
 * Every browser has a cap and they differ - Safari's is 2^24 and Firefox's is
 * around 17.8 million - so the ceiling is counted in device pixels, where the
 * caps live, and a retina display halves what a CSS pixel buys.
 *
 * The answer is to give the container a height it can actually have and relate
 * the two spaces by a ratio. What that costs is scroll *resolution*: a wheel
 * notch travels further on a diff seven times taller than its scrollbar. What
 * it buys is the far end of the diff existing.
 */
describe('a diff taller than the browser will scroll', () => {
  const ceiling = 1000
  const viewportHeight = 100

  test('an ordinary diff is untouched, which is the case that matters most', () => {
    const space = scrollSpace(600, viewportHeight, ceiling)

    expect(space.compressed).toBe(false)
    expect(space.scrollHeight).toBe(600)
    expect(space.ratio).toBe(1)
    // Not "close to": the same number. Every diff anybody reviews goes through
    // this path, and a rounding error here would be a viewer that drifts.
    expect(space.toContent(123.5)).toBe(123.5)
    expect(space.toScroll(123.5)).toBe(123.5)
  })

  test('a diff at the ceiling exactly is still untouched', () => {
    expect(scrollSpace(ceiling, viewportHeight, ceiling).compressed).toBe(false)
  })

  test('past it, the container is given a height the browser will honour', () => {
    const space = scrollSpace(10_000, viewportHeight, ceiling)

    expect(space.compressed).toBe(true)
    expect(space.scrollHeight).toBe(ceiling)
  })

  test('the two ends line up, which is the whole point', () => {
    const space = scrollSpace(10_000, viewportHeight, ceiling)

    // The top of the scrollbar is the top of the diff.
    expect(space.toContent(0)).toBe(0)
    // And the bottom of the scrollbar is the bottom of the diff - the last
    // screenful, not two thirds of the way in.
    expect(space.toContent(ceiling - viewportHeight)).toBe(10_000 - viewportHeight)
  })

  test('and the map is reversible, so scrolling to a file lands on it', () => {
    const space = scrollSpace(10_000, viewportHeight, ceiling)

    for (const contentTop of [0, 1, 4321, 9000, 9900]) {
      // Within a pixel: the map is a ratio, and the caller snaps to the device
      // pixel grid afterwards anyway.
      expect(Math.abs(space.toContent(space.toScroll(contentTop)) - contentTop)).toBeLessThan(1)
    }
  })

  test('scroll positions past either end are clamped rather than extrapolated', () => {
    const space = scrollSpace(10_000, viewportHeight, ceiling)

    expect(space.toContent(-500)).toBe(0)
    expect(space.toContent(999_999)).toBe(10_000 - viewportHeight)
    expect(space.toScroll(-500)).toBe(0)
    expect(space.toScroll(999_999)).toBe(ceiling - viewportHeight)
  })

  test('the ratio says how much resolution was traded, and it degrades in proportion', () => {
    // Barely over: barely compressed. This is the honest shape of the trade -
    // nothing falls off a cliff at the ceiling.
    const barely = scrollSpace(1100, viewportHeight, ceiling)
    const badly = scrollSpace(10_000, viewportHeight, ceiling)

    expect(barely.ratio).toBeCloseTo(1000 / 900, 3)
    expect(badly.ratio).toBeCloseTo(9900 / 900, 3)
    expect(barely.ratio).toBeLessThan(badly.ratio)
  })

  test('a viewport taller than the ceiling does not divide by zero', () => {
    // Not a viewport anybody has, and the failure would be every position
    // becoming NaN, which renders as a blank page rather than as an error.
    const space = scrollSpace(10_000, 2000, ceiling)

    expect(Number.isFinite(space.toContent(10))).toBe(true)
    expect(Number.isFinite(space.toScroll(10))).toBe(true)
  })

  test('the ceiling is in device pixels, so a retina display gets half as many', () => {
    expect(scrollCeiling(1)).toBe(MAX_SCROLL_DEVICE_PIXELS)
    expect(scrollCeiling(2)).toBe(MAX_SCROLL_DEVICE_PIXELS / 2)
    // A ratio below one is not a display, and dividing by it would raise the
    // ceiling above what the browser allows.
    expect(scrollCeiling(0)).toBe(MAX_SCROLL_DEVICE_PIXELS)
  })

  test('it is under the lowest cap any browser has', () => {
    // Safari's is 2^24. Being under the smallest is what makes one number
    // correct everywhere rather than correct on the machine it was measured on.
    expect(MAX_SCROLL_DEVICE_PIXELS).toBeLessThan(2 ** 24)
  })
})

describe('planning a frame in a compressed diff', () => {
  /** Enough files that the list is far taller than the ceiling below. */
  const many: ViewportFile[] = Array.from({ length: 4000 }, () => ({ rows: rows(40), collapsed: false }))
  const viewport = { scrollTop: 0, height: 800 }
  const ceiling = 20_000

  test('mounts the last files when the reader is at the end of the scrollbar', () => {
    const total = measuredLayout(many).total

    expect(total).toBeGreaterThan(ceiling)

    const atEnd = planFrame(many, new Set(), { ...viewport, scrollTop: ceiling - viewport.height }, { ceiling })

    // The failure this replaces: the plan was computed from a scroll position
    // that meant something else, so the end of the scrollbar planned the
    // *first* screen and the reader saw nothing.
    expect(atEnd.plan.next.size).toBeGreaterThan(0)
    expect(Math.max(...atEnd.plan.next)).toBe(many.length - 1)
  })

  test('mounts the first files at the top, as it always did', () => {
    const atTop = planFrame(many, new Set(), viewport, { ceiling })

    expect(atTop.plan.next.has(0)).toBe(true)
    expect(atTop.contentTop).toBe(0)
  })

  test('reports the map and the position it planned with', () => {
    const middle = planFrame(many, new Set(), { ...viewport, scrollTop: (ceiling - viewport.height) / 2 }, { ceiling })

    expect(middle.space.compressed).toBe(true)
    // Returned rather than left for the caller to recompute: the caller would
    // have to recompute it from the *corrected* scroll position, and would be
    // one frame's drift wrong every time it used the uncorrected one.
    expect(middle.contentTop).toBeCloseTo((middle.layout.total - viewport.height) / 2, 0)
  })

  test('an uncompressed diff plans exactly as before', () => {
    const few: ViewportFile[] = Array.from({ length: 5 }, () => ({ rows: rows(10), collapsed: false }))
    const frame = planFrame(few, new Set(), { scrollTop: 40, height: 800 })

    expect(frame.space.compressed).toBe(false)
    expect(frame.contentTop).toBe(40)
  })

  test('an anchor is restored in the space the caller writes into', () => {
    const layout = measuredLayout(many)
    // The reader is looking at file 3,000, forty pixels in.
    const anchor = { index: 3000, offset: 40 }
    const frame = planFrame(many, new Set(), viewport, { ceiling, anchor })

    expect(frame.scrollTop).not.toBeUndefined()
    // Written to the scrollbar, so it has to be inside the scrollbar's range.
    expect(frame.scrollTop!).toBeLessThanOrEqual(ceiling - viewport.height)
    // And it has to put the reader back where they were, in the diff.
    expect(Math.abs(frame.contentTop - (layout.offsets[3000]! + 40))).toBeLessThan(ceiling)
    expect(frame.plan.next.has(3000)).toBe(true)
  })

  test('scrolling to a file answers in the scrollbar\'s range, not the diff\'s', () => {
    const frame = planFrame(many, new Set(), viewport, { ceiling })
    const target = scrollTargetFor(frame.layout, viewport.height, { index: many.length - 1 }, frame.space)

    expect(target).not.toBeNull()
    expect(target!).toBeLessThanOrEqual(ceiling - viewport.height)

    // And it really does reach the last file: planning from that position
    // mounts it. Without the map this asked for a position several times past
    // the end of the scrollbar and the browser landed wherever it could.
    const arrived = planFrame(many, new Set(), { ...viewport, scrollTop: target! }, { ceiling })

    expect(arrived.plan.next.has(many.length - 1)).toBe(true)
  })
})

/**
 * Extending the position map instead of rebuilding it.
 *
 * A manifest arrives as one batch per twenty-five files, and rebuilding the
 * whole map for each batch is work proportional to the diff rather than to the
 * batch - about 125 million map insertions over a diff of eighty thousand
 * files, to discover twenty-five new positions each time. It was measured at
 * 53% of everything the main thread did while a very large diff was loading,
 * and the page decelerated as it went, which is what quadratic looks like from
 * the outside.
 *
 * The property that makes appending sound is that it moves nothing already in
 * the list. What is worth testing is that the shortcut and the rebuild never
 * disagree: a position map that has drifted is a viewer that scrolls to the
 * wrong file, mounts rows under the wrong header, and posts a comment on a line
 * in a file nobody was looking at.
 */
describe('appendPositions', () => {
  /** The same list, indexed both ways. */
  function bothWays(batches: number[][]): { appended: Map<number, number>, rebuilt: Map<number, number> } {
    const keys: number[] = []
    const appended = new Map<number, number>()

    for (const batch of batches) {
      const from = keys.length
      keys.push(...batch)
      appendPositions(appended, keys, from)
    }

    return { appended, rebuilt: positionsByKey(keys) }
  }

  test('agrees with a rebuild, batch after batch', () => {
    const { appended, rebuilt } = bothWays([[10, 11, 12], [13, 14], [15]])

    expect([...appended.entries()].sort()).toEqual([...rebuilt.entries()].sort())
  })

  test('agrees when the diff numbers are not contiguous', () => {
    // Which they are not: a filtered list, or a diff whose files were numbered
    // by the manifest and then narrowed.
    const { appended, rebuilt } = bothWays([[4, 9], [100, 7], [0]])

    expect([...appended.entries()].sort()).toEqual([...rebuilt.entries()].sort())
  })

  test('an empty batch changes nothing', () => {
    const positions = new Map([[7, 0]])

    appendPositions(positions, [7], 1)

    expect([...positions.entries()]).toEqual([[7, 0]])
  })

  test('appending one at a time is the same as appending all at once', () => {
    const oneByOne = bothWays([[1], [2], [3], [4], [5]])
    const allAtOnce = bothWays([[1, 2, 3, 4, 5]])

    expect([...oneByOne.appended.entries()].sort()).toEqual([...allAtOnce.appended.entries()].sort())
  })

  test('touches only what was appended, which is the whole point', () => {
    // Asserted by counting the writes rather than by timing: a rebuild would
    // write every position again, and on the batch that takes a diff from
    // 79,975 files to 80,000 that is the difference between 25 writes and
    // 80,000.
    const keys = Array.from({ length: 1000 }, (_, index) => index)
    const positions = positionsByKey(keys.slice(0, 975))

    let writes = 0
    const counted = new Map<number, number>(positions)
    const original = counted.set.bind(counted)
    counted.set = (key: number, value: number) => {
      writes++
      return original(key, value)
    }

    appendPositions(counted, keys, 975)

    expect(writes).toBe(25)
    expect(counted.get(999)).toBe(999)
  })
})
