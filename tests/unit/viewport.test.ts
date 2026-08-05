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

  test('a collapsed file is its header even after it was measured open', () => {
    const list = files(2)
    list[0]!.measured = 1000
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
