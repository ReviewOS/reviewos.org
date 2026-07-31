// How long "mute for a while" lasts.
//
// The case worth pinning is "until tomorrow" chosen late at night. Computed
// from now it expires in minutes, which is the version of this feature people
// find infuriating; computed from local midnight it does what it says.

import { describe, expect, test } from 'bun:test'
import { MUTE_DURATIONS, muteExpiry } from '../../app/Actions/Notification/settings'

const HOUR = 3_600_000

// 2024-01-16T23:50:00Z, a Tuesday, ten minutes before UTC midnight.
const lateAtNight = Date.UTC(2024, 0, 16, 23, 50, 0)

// 2024-01-16T09:00:00Z, the same Tuesday morning.
const morning = Date.UTC(2024, 0, 16, 9, 0, 0)

describe('muteExpiry', () => {
  test('an hour is an hour', () => {
    expect(muteExpiry('1h', 'UTC', morning)).toBe(morning + HOUR)
  })

  test('eight hours covers a working day', () => {
    expect(muteExpiry('8h', 'UTC', morning)).toBe(morning + 8 * HOUR)
  })

  test('until tomorrow means local midnight, not twenty-four hours', () => {
    expect(muteExpiry('tomorrow', 'UTC', morning)).toBe(morning + 15 * HOUR)
  })

  test('until tomorrow chosen at 23:50 lasts ten minutes, not none', () => {
    // Ten minutes is correct here: tomorrow really is ten minutes away. What
    // would be wrong is computing it from a stored offset and landing in the
    // past.
    expect(muteExpiry('tomorrow', 'UTC', lateAtNight)).toBe(lateAtNight + 10 * 60_000)
  })

  test('local midnight is the recipient\'s, not the server\'s', () => {
    // 23:50 UTC is 00:50 on Wednesday in Berlin, so "tomorrow" there is
    // Thursday morning: 23 hours and 10 minutes away, not ten minutes.
    expect(muteExpiry('tomorrow', 'Europe/Berlin', lateAtNight)).toBe(lateAtNight + (23 * 60 + 10) * 60_000)
  })

  test('a week runs to midnight six days later', () => {
    expect(muteExpiry('week', 'UTC', morning)).toBe(morning + 15 * HOUR + 6 * 24 * HOUR)
  })

  test('forever has no expiry', () => {
    expect(muteExpiry('forever', 'UTC', morning)).toBeNull()
  })

  test('every named duration is handled', () => {
    for (const duration of MUTE_DURATIONS) {
      const expiry = muteExpiry(duration, 'UTC', morning)

      expect(expiry === null || expiry > morning).toBe(true)
    }
  })
})
