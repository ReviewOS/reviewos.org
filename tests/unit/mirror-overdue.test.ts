/**
 * Counting the mirrors that say the clock has stopped.
 *
 * Every way a sync can fail writes `last_error` and increments
 * `failure_count`, so a mirror that is far past its interval with a clean
 * record is a mirror nothing ever came for. That is a statement about the
 * instance rather than about the mirror, and it is the only evidence a health
 * check has that `buddy schedule:run` is not running - which no documented
 * deployment ran, on any instance, until it did.
 */

import { describe, expect, it } from 'bun:test'
import { staleMirrors } from '../../app/Actions/Mirror/overdue'

const now = new Date('2026-08-19T12:00:00Z')

function mirror(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    interval_seconds: 900,
    last_synced_at: '2026-08-19T11:55:00Z',
    last_error: null,
    failure_count: 0,
    ...overrides,
  } as any
}

describe('staleMirrors', () => {
  it('counts nothing on an instance whose mirrors are current', () => {
    expect(staleMirrors([mirror(), mirror()], now)).toBe(0)
  })

  it('counts nothing at all on an instance with no mirrors', () => {
    // No evidence either way. A check that warns without evidence is a check
    // people turn off.
    expect(staleMirrors([], now)).toBe(0)
  })

  it('counts a mirror a day past a fifteen-minute interval', () => {
    expect(staleMirrors([mirror({ last_synced_at: '2026-08-18T12:00:00Z' })], now)).toBe(1)
  })

  it('does not count one that is merely a little late', () => {
    // A sweep is routinely a bit behind - the queue is busy, the last run
    // overlapped - and a count that trips every hour teaches people to ignore
    // it by the time it means something.
    expect(staleMirrors([mirror({ last_synced_at: '2026-08-19T11:40:00Z' })], now)).toBe(0)
  })

  it('does not count a mirror that is failing', () => {
    // Being swept perfectly well and erroring every time is a credential to
    // fix. Counting it here points an operator at the clock.
    const failing = mirror({ last_synced_at: '2026-08-18T12:00:00Z', failure_count: 5, last_error: 'Authentication failed' })

    expect(staleMirrors([failing], now)).toBe(0)
  })

  it('does not count one that has never synced', () => {
    // The ordinary state of a mirror created a minute ago, which says "not
    // synced yet" on the page rather than claiming anything.
    expect(staleMirrors([mirror({ last_synced_at: null })], now)).toBe(0)
  })

  it('does not count a disabled mirror', () => {
    // Switched off is a decision, not a fault.
    const off = mirror({ enabled: false, last_synced_at: '2026-08-18T12:00:00Z' })

    expect(staleMirrors([off], now)).toBe(0)
  })

  it('counts each stalled mirror once, and leaves the healthy ones out', () => {
    const rows = [
      mirror(),
      mirror({ last_synced_at: '2026-08-18T12:00:00Z' }),
      mirror({ last_synced_at: '2026-08-17T12:00:00Z' }),
      mirror({ last_synced_at: '2026-08-18T12:00:00Z', failure_count: 9, last_error: 'gone' }),
    ]

    expect(staleMirrors(rows, now)).toBe(2)
  })
})
