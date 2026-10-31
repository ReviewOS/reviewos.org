// What a held claim leaves on the runner's row.
//
// A runner that checks its own disk before claiming says "no work" on every
// poll until it has room. These are the rules for turning that poll into the
// `hold_reason` the run page and the fleet listing read, in both directions of
// a mixed-version fleet.

import { describe, expect, test } from 'bun:test'
import { HOLD_REASON_MAX, holdFromClaim, holdUpdate, UNEXPLAINED_HOLD } from '../../app/Actions/Runner/hold'

describe('what a claim says about capacity', () => {
  test('a runner that accepts work is not holding', () => {
    expect(holdFromClaim(undefined, undefined)).toBeNull()
    expect(holdFromClaim(true, 'stale reason')).toBeNull()
  })

  test('a held claim keeps the runner\'s own words', () => {
    const reason = 'Insufficient workspace disk space at /work: 9355 MiB available, 24576 MiB required'

    expect(holdFromClaim(false, reason)).toBe(reason)
  })

  test('an older runner that holds without a reason is still recorded as holding', () => {
    expect(holdFromClaim(false, undefined)).toBe(UNEXPLAINED_HOLD)
    expect(holdFromClaim(false, '   ')).toBe(UNEXPLAINED_HOLD)
    expect(holdFromClaim(false, 42)).toBe(UNEXPLAINED_HOLD)
  })

  test('control characters and runaway length are folded away', () => {
    expect(holdFromClaim(false, 'line one\nline\u001B[31m two')).toBe('line one line [31m two')
    expect(holdFromClaim(false, 'x'.repeat(5000))?.length).toBe(HOLD_REASON_MAX)
  })
})

describe('what is written to the row', () => {
  const now = new Date('2026-10-30T22:04:00.000Z')
  const reason = 'Insufficient workspace disk space'

  test('the first held poll records the reason and when it began', () => {
    expect(holdUpdate({ reason: null, startedAt: null }, reason, now))
      .toEqual({ hold_reason: reason, hold_started_at: '2026-10-30T22:04:00.000Z' })
  })

  test('the same hold polled again writes nothing', () => {
    expect(holdUpdate({ reason, startedAt: '2026-10-30T22:00:00.000Z' }, reason, now)).toBeNull()
  })

  test('a changed reason keeps the original start', () => {
    expect(holdUpdate({ reason, startedAt: '2026-10-30T22:00:00.000Z' }, 'Host load is too high', now))
      .toEqual({ hold_reason: 'Host load is too high', hold_started_at: '2026-10-30T22:00:00.000Z' })
  })

  test('accepting work clears the hold, once', () => {
    expect(holdUpdate({ reason, startedAt: '2026-10-30T22:00:00.000Z' }, null, now))
      .toEqual({ hold_reason: null, hold_started_at: null })
    expect(holdUpdate({ reason: null, startedAt: null }, null, now)).toBeNull()
  })
})
