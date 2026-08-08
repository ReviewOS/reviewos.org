// Who gets warned, when, and how many times.
//
// Everything that makes this correct is a boundary: the day a token crosses
// each threshold, the fact that it has already been told, and the point past
// which telling anybody is pointless. All of them are cheap to test here and
// expensive to discover in production, where the failure is either silence or
// a daily email about the same token for a week.

import { describe, expect, test } from 'bun:test'
import { describeDeadline, warningFor, WARNING_THRESHOLDS_DAYS, widestWindowMs } from '../../app/Actions/Tokens/expiry'

const NOW = Date.parse('2026-08-08T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const active = (expiresAtMs: number | null, warnedDays: number | null = null) =>
  ({ state: 'active' as const, expiresAtMs, warnedDays })

describe('warningFor', () => {
  test('says nothing about a token that is months away', () => {
    expect(warningFor(active(NOW + 60 * DAY), NOW)).toEqual({ warn: false, reason: 'too-far-out' })
  })

  test('warns once the seven-day window opens', () => {
    const decision = warningFor(active(NOW + 6 * DAY), NOW)

    expect(decision).toMatchObject({ warn: true, thresholdDays: 7 })
  })

  test('does not warn again inside the same window', () => {
    // The sweep runs daily and a token sits inside the seven-day window for a
    // week. Without this, that is seven identical emails, and somebody who is
    // mailed seven times about one token builds a filter - which then hides the
    // one-day notice as well.
    expect(warningFor(active(NOW + 5 * DAY, 7), NOW)).toEqual({ warn: false, reason: 'already-warned' })
    expect(warningFor(active(NOW + 3 * DAY, 7), NOW)).toEqual({ warn: false, reason: 'already-warned' })
  })

  test('warns a second time when the window narrows to a day', () => {
    // The reminder for whoever read the first mail on a Friday and meant to do
    // it on Monday.
    const decision = warningFor(active(NOW + 0.5 * DAY, 7), NOW)

    expect(decision).toMatchObject({ warn: true, thresholdDays: 1 })
  })

  test('and then stops for good', () => {
    expect(warningFor(active(NOW + 0.25 * DAY, 1), NOW)).toEqual({ warn: false, reason: 'already-warned' })
  })

  test('says nothing about a token that has already expired', () => {
    // There is no action left for the mail to ask for, so it can only annoy.
    expect(warningFor(active(NOW - DAY), NOW)).toEqual({ warn: false, reason: 'not-active' })
    expect(warningFor({ state: 'expired', expiresAtMs: NOW - DAY, warnedDays: null }, NOW))
      .toEqual({ warn: false, reason: 'not-active' })
  })

  test('says nothing about a revoked token', () => {
    expect(warningFor({ state: 'revoked', expiresAtMs: NOW + DAY, warnedDays: null }, NOW))
      .toEqual({ warn: false, reason: 'not-active' })
  })

  test('the exact boundary counts as inside the window', () => {
    // Seven days to the millisecond. Off by one here means the widest warning
    // is skipped by a sweep that happens to run on the boundary, and the first
    // thing anybody hears is the one-day notice.
    expect(warningFor(active(NOW + 7 * DAY), NOW)).toMatchObject({ warn: true, thresholdDays: 7 })
    expect(warningFor(active(NOW + 7 * DAY + 1), NOW)).toEqual({ warn: false, reason: 'too-far-out' })
  })

  test('a rotated token still gets its one-day notice', () => {
    // Rotation brings the old token's expiry forward to the end of its overlap.
    // If it had already had the seven-day warning, the tighter window has to
    // still fire - otherwise rotating is a way to silence the last warning.
    const decision = warningFor(active(NOW + DAY, 7), NOW)

    expect(decision).toMatchObject({ warn: true, thresholdDays: 1 })
  })
})

describe('describeDeadline', () => {
  test('answers the question the reader is actually asking', () => {
    // Whether this is today's problem. A timestamp makes them work it out and
    // they will not.
    expect(describeDeadline(6.4)).toBe('in 6 days')
    expect(describeDeadline(1)).toBe('tomorrow')
    expect(describeDeadline(0.5)).toBe('in about 12 hours')
    expect(describeDeadline(0.02)).toBe('in about an hour')
  })
})

describe('the sweep window', () => {
  test('is wide enough to cover every threshold', () => {
    // The query bounds itself with this. If it were narrower than the widest
    // threshold, that warning would never be found and nothing would say so.
    for (const threshold of WARNING_THRESHOLDS_DAYS)
      expect(widestWindowMs()).toBeGreaterThanOrEqual(threshold * DAY)
  })
})
