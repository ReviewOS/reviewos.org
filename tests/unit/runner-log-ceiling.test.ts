// What a job's log keeps once it is too big: the start and the end.
//
// HQ's unit job (run 2443, job 6809) failed past the two-megabyte ceiling, and
// the stored log was the first two megabytes - checkout and install - with the
// failure summary dropped. These are the rules that keep the tail instead.

import { describe, expect, test } from 'bun:test'
import type { StoredChunk } from '../../app/Actions/Runner/logCeiling'
import { droppedMarker, HEAD_SHARE, markerOf, planCeiling, withoutMarker } from '../../app/Actions/Runner/logCeiling'

const CEILING = 1000

function chunks(sizes: number[], from = 1): StoredChunk[] {
  return sizes.map((bytes, index) => ({ sequence: from + index, bytes, dropped: 0, markerBytes: 0 }))
}

describe('the marker', () => {
  test('says how much was dropped, and can be read back', () => {
    const marker = droppedMarker(123456, 2097152)

    expect(marker).toContain('[log truncated: 123456 bytes dropped here')
    expect(markerOf(`${marker}FAIL tests/unit/x.test.ts\n`).dropped).toBe(123456)
    expect(withoutMarker(`${marker}rest`)).toBe('rest')
    expect(markerOf('ordinary output\n').dropped).toBe(0)
  })
})

describe('planning one append', () => {
  test('under the ceiling, it is stored', () => {
    expect(planCeiling(chunks([100, 100]), { sequence: 3, bytes: 100 }, CEILING)).toEqual({ action: 'store' })
  })

  test('a resend of a stored chunk is left to the unique index', () => {
    expect(planCeiling(chunks([600, 390]), { sequence: 2, bytes: 390 }, CEILING)).toEqual({ action: 'store' })
  })

  test('past the ceiling, the oldest chunks after the head go, never the head', () => {
    // Head share is a quarter: the first two 100-byte chunks are the head.
    expect(HEAD_SHARE).toBe(0.25)
    const plan = planCeiling(chunks([100, 100, 200, 200, 200, 150]), { sequence: 7, bytes: 200 }, CEILING)

    // Room is kept for the marker line itself (MARKER_ROOM), so three go.
    expect(plan).toEqual({ action: 'rotate', remove: [3, 4, 5], markerOn: 6, dropped: 600, clipIncoming: 0 })
  })

  test('the marker moves forward and keeps the running total', () => {
    // After a first rotation: head 1-2, marker on 5 saying 400 dropped.
    const stored: StoredChunk[] = [
      ...chunks([100, 100]),
      { sequence: 5, bytes: 300, dropped: 400, markerBytes: 100 },
      ...chunks([150, 200], 6),
    ]
    const plan = planCeiling(stored, { sequence: 8, bytes: 300 }, CEILING)

    expect(plan.action).toBe('rotate')
    if (plan.action !== 'rotate')
      return
    // Chunk 5 goes: its own 200 bytes of output plus the 400 its marker carried.
    expect(plan.remove[0]).toBe(5)
    expect(plan.dropped).toBe(400 + 200 + (plan.remove.includes(6) ? 150 : 0))
    expect(plan.markerOn).toBe(plan.remove.includes(6) ? 7 : 6)
  })

  test('a resend of a chunk dropped from the middle is accepted and dropped', () => {
    const stored: StoredChunk[] = [...chunks([100, 100]), { sequence: 5, bytes: 300, dropped: 400, markerBytes: 100 }]

    expect(planCeiling(stored, { sequence: 3, bytes: 200 }, CEILING)).toEqual({ action: 'drop' })
  })

  test('when nothing after the head survives, the incoming chunk carries the marker', () => {
    const plan = planCeiling(chunks([200, 700]), { sequence: 3, bytes: 500 }, CEILING)

    expect(plan).toEqual({ action: 'rotate', remove: [2], markerOn: 3, dropped: 700, clipIncoming: 0 })
  })
})
