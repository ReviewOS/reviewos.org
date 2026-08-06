// The decisions a virtualized list makes, tested without a DOM.
//
// These are the bugs that do not show up in a screenshot: a file remounted
// every frame, an anchor that drifts, a window that misses the file the reader
// is looking at, a collapsed file still scrolled three hundred pixels into.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_HEIGHT_METRICS, layoutList } from '../../app/Actions/Pull/metrics'
import {
  captureAnchor,
  measuredLayout,
  planFrame,
  planMounts,
  restoreAnchor,
  scrollBehaviourFor,
  scrollTargetFor,
  snapToDevicePixel,
  type ViewportFile,
} from '../../app/Actions/Pull/viewport'

const rows = (count: number) => ({ unified: count, split: count })

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
