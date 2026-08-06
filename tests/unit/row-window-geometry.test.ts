/**
 * Which rows of a very large file belong on screen.
 *
 * The list virtualizes files; this is what virtualizes the inside of one. Every
 * bug here is invisible in a screenshot and obvious in a test: a window that
 * does not cover what the reader can see, a scrollbar that says a hundred
 * thousand line file is four screens long, or a refetch on every frame of a
 * slow scroll.
 */

import { describe, expect, test } from 'bun:test'
import {
  needsWindow,
  shouldWindow,
  spacers,
  visibleRows,
  WINDOW_ABOVE_ROWS,
  WINDOW_ROWS,
  windowFor,
} from '../../app/Actions/Pull/window'

describe('shouldWindow', () => {
  test('a file of ordinary size is mounted whole', () => {
    expect(shouldWindow(50)).toBe(false)
    expect(shouldWindow(WINDOW_ABOVE_ROWS)).toBe(false)
  })

  test('a file past the threshold is windowed', () => {
    expect(shouldWindow(WINDOW_ABOVE_ROWS + 1)).toBe(true)
    expect(shouldWindow(400_000)).toBe(true)
  })
})

describe('visibleRows', () => {
  const base = { fileTop: 1000, totalRows: 100_000, rowHeight: 20, viewportHeight: 800 }

  test('the rows under the viewport, when it sits over the middle of the file', () => {
    // 1000 rows down the file, 40 rows of viewport.
    expect(visibleRows({ ...base, scrollTop: 1000 + 1000 * 20 })).toEqual({ from: 1000, to: 1040 })
  })

  test('clamps at the top rather than reporting negative rows', () => {
    expect(visibleRows({ ...base, scrollTop: 0 }).from).toBe(0)
  })

  test('clamps at the end rather than past it', () => {
    const far = visibleRows({ ...base, scrollTop: 1000 + 200_000 * 20 })

    expect(far.to).toBe(base.totalRows)
    expect(far.from).toBeLessThanOrEqual(base.totalRows)
  })

  test('a nonsense row height is empty rather than infinite', () => {
    expect(visibleRows({ ...base, scrollTop: 0, rowHeight: 0 })).toEqual({ from: 0, to: 0 })
  })

  /**
   * Why the caller measures instead of assuming.
   *
   * With word wrap on, a row can be two or three lines tall. Passing the
   * one-line metric anyway does not merely make the scrollbar inexact - it
   * reports twice as many rows on screen as there are, and every window chosen
   * from that lands below where the reader actually is. The fix is entirely in
   * which number is passed, so this is what pins that the number matters.
   */
  test('a taller row means fewer rows visible, not the same rows further down', () => {
    const oneLine = visibleRows({ ...base, scrollTop: 1000, rowHeight: 20 })
    const wrapped = visibleRows({ ...base, scrollTop: 1000, rowHeight: 40 })

    expect(oneLine.to - oneLine.from).toBe(40)
    expect(wrapped.to - wrapped.from).toBe(20)
  })

  /**
   * And the two uses of that number have to agree. The spacer above the window
   * is `from * rowHeight` tall, so a reader scrolled to the bottom of it is
   * looking at row `from` - which only holds if the row height that sized the
   * spacer is the row height that reads it back.
   */
  test('the row at the foot of the spacer above is the row the spacer stands in for', () => {
    for (const rowHeight of [20, 44, 61.5]) {
      const held = { from: 600, to: 1200 }
      const { above } = spacers(held, base.totalRows, rowHeight)

      const at = visibleRows({
        ...base,
        rowHeight,
        viewportHeight: 0,
        scrollTop: base.fileTop + above,
      })

      expect(at.from).toBe(held.from)
    }
  })
})

describe('windowFor', () => {
  test('covers the visible rows', () => {
    const visible = { from: 5_000, to: 5_040 }
    const held = windowFor(visible, 100_000)

    expect(held.from).toBeLessThanOrEqual(visible.from)
    expect(held.to).toBeGreaterThanOrEqual(visible.to)
  })

  /**
   * The reason for aligning to a grid. Without it, a slow scroll asks for a
   * range nudged by one on every frame, and every one of those is a request.
   */
  test('is the same answer for every position within a step', () => {
    const first = windowFor({ from: 5_000, to: 5_040 }, 100_000)

    for (let offset = 0; offset < 50; offset++)
      expect(windowFor({ from: 5_000 + offset, to: 5_040 + offset }, 100_000)).toEqual(first)
  })

  test('never asks for rows before the start or past the end', () => {
    expect(windowFor({ from: 0, to: 40 }, 100_000).from).toBe(0)
    expect(windowFor({ from: 99_990, to: 100_000 }, 100_000).to).toBe(100_000)
  })

  test('a file with no rows asks for nothing', () => {
    expect(windowFor({ from: 0, to: 0 }, 0)).toEqual({ from: 0, to: 0 })
  })

  test('holds more than one screen either side of what is visible', () => {
    const held = windowFor({ from: 5_000, to: 5_040 }, 100_000)

    expect(held.to - held.from).toBe(WINDOW_ROWS * 2)
  })
})

describe('needsWindow', () => {
  const total = 100_000

  test('nothing held means fetch', () => {
    expect(needsWindow(null, { from: 0, to: 40 }, total)).toBe(true)
  })

  test('comfortably inside means do not', () => {
    expect(needsWindow({ from: 4_800, to: 6_000 }, { from: 5_000, to: 5_040 }, total)).toBe(false)
  })

  /** Asked for before the reader arrives, so the reply beats them there. */
  test('close to an edge means fetch, before the rows have actually run out', () => {
    expect(needsWindow({ from: 4_800, to: 6_000 }, { from: 5_900, to: 5_960 }, total)).toBe(true)
    expect(needsWindow({ from: 4_800, to: 6_000 }, { from: 4_820, to: 4_880 }, total)).toBe(true)
  })

  /**
   * There is nothing to fetch past the ends of the file, so being near one is
   * not a reason to ask - otherwise the top of every windowed file refetches
   * forever.
   */
  test('the file\'s own edges are never too close', () => {
    expect(needsWindow({ from: 0, to: 1_200 }, { from: 0, to: 40 }, total)).toBe(false)
    expect(needsWindow({ from: 98_800, to: total }, { from: 99_960, to: total }, total)).toBe(false)
  })
})

describe('spacers', () => {
  test('stand in for exactly the rows that are not in the document', () => {
    expect(spacers({ from: 1_000, to: 2_200 }, 100_000, 20)).toEqual({
      above: 1_000 * 20,
      below: (100_000 - 2_200) * 20,
    })
  })

  /**
   * The scrollbar has to mean something. Without the spacers a windowed file
   * would be as tall as its window, and a reader would reach the end of a
   * hundred thousand line file in four screens.
   */
  test('the whole file is as tall as all of its rows, wherever the window sits', () => {
    const total = 100_000
    const rowHeight = 20

    for (const from of [0, 500, 50_000, 99_000]) {
      const held = { from, to: Math.min(total, from + 1_200) }
      const { above, below } = spacers(held, total, rowHeight)

      expect(above + (held.to - held.from) * rowHeight + below).toBe(total * rowHeight)
    }
  })

  test('a window covering the whole file needs no spacers at all', () => {
    expect(spacers({ from: 0, to: 100 }, 100, 20)).toEqual({ above: 0, below: 0 })
  })
})
