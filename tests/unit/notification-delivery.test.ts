// When a notification is allowed to reach someone.
//
// The cases that matter are the ones where a person is asleep, on a weekend, or
// has deliberately muted something, and the thing being protected is that none
// of those ever loses the notification. Held is not dropped, and the inbox
// always records it.

import { describe, expect, test } from 'bun:test'
import {
  decisionText,
  deliveryDecision,
  isWithinWindow,
  minutesUntilOpen,
  muteApplies,
} from '../../app/Actions/Notification/delivery'

/** Weekdays, 09:00 to 18:00. */
const workingHours = { days: [1, 2, 3, 4, 5], startsAt: 9 * 60, endsAt: 18 * 60 }

/** A night shift, Monday to Friday, 22:00 through to 06:00 the next morning. */
const nightShift = { days: [1, 2, 3, 4, 5], startsAt: 22 * 60, endsAt: 6 * 60 }

/** Tuesday at 14:00, with an arbitrary but fixed absolute time. */
const tuesdayAfternoon = { epochMs: 1_700_000_000_000, weekday: 2, minutes: 14 * 60 }

/** Tuesday at 23:00. */
const tuesdayNight = { epochMs: 1_700_000_000_000, weekday: 2, minutes: 23 * 60 }

/** Saturday at 14:00. */
const saturdayAfternoon = { epochMs: 1_700_000_000_000, weekday: 6, minutes: 14 * 60 }

describe('isWithinWindow', () => {
  test('inside working hours on a working day', () => {
    expect(isWithinWindow(workingHours, 2, 14 * 60)).toBe(true)
  })

  test('the same hour on a weekend is outside', () => {
    expect(isWithinWindow(workingHours, 6, 14 * 60)).toBe(false)
  })

  test('the end of the window is exclusive, so 18:00 is already outside', () => {
    expect(isWithinWindow(workingHours, 2, 18 * 60)).toBe(false)
    expect(isWithinWindow(workingHours, 2, 18 * 60 - 1)).toBe(true)
  })

  test('a window that wraps past midnight covers the late evening', () => {
    expect(isWithinWindow(nightShift, 2, 23 * 60)).toBe(true)
  })

  test('a wrapping window covers the following morning', () => {
    // Wednesday 02:00 belongs to Tuesday's window, which is why the day a
    // window is listed under has to be the day it starts.
    expect(isWithinWindow(nightShift, 3, 2 * 60)).toBe(true)
  })

  test('a wrapping window does not cover the morning after its last day', () => {
    // Saturday 02:00 runs on from Friday, which is listed. Sunday 02:00 runs on
    // from Saturday, which is not.
    expect(isWithinWindow(nightShift, 6, 2 * 60)).toBe(true)
    expect(isWithinWindow(nightShift, 0, 2 * 60)).toBe(false)
  })
})

describe('minutesUntilOpen', () => {
  test('later the same day', () => {
    expect(minutesUntilOpen(workingHours, { weekday: 2, minutes: 7 * 60 })).toBe(2 * 60)
  })

  test('after the window closes, it is the next working morning', () => {
    // Tuesday 20:00 to Wednesday 09:00 is thirteen hours.
    expect(minutesUntilOpen(workingHours, { weekday: 2, minutes: 20 * 60 })).toBe(13 * 60)
  })

  test('a Friday evening waits until Monday', () => {
    // Friday 20:00 to Monday 09:00 is 61 hours.
    expect(minutesUntilOpen(workingHours, { weekday: 5, minutes: 20 * 60 })).toBe(61 * 60)
  })

  test('a Saturday afternoon waits until Monday', () => {
    // Saturday 14:00 to Monday 09:00 is 43 hours.
    expect(minutesUntilOpen(workingHours, { weekday: 6, minutes: 14 * 60 })).toBe(43 * 60)
  })

  test('a schedule with one day still comes back around', () => {
    const mondaysOnly = { days: [1], startsAt: 9 * 60, endsAt: 18 * 60 }

    // Monday 10:00 is inside the window, so the *next* opening is a week away.
    expect(minutesUntilOpen(mondaysOnly, { weekday: 1, minutes: 10 * 60 })).toBe(7 * 24 * 60 - 60)
  })
})

describe('deliveryDecision', () => {
  test('inside the window it goes out', () => {
    const result = deliveryDecision({ channel: 'push', now: tuesdayAfternoon, schedule: workingHours })

    expect(result.decision).toBe('send')
    expect(result.because).toBe('open')
  })

  test('outside the window it is held, not dropped', () => {
    const result = deliveryDecision({ channel: 'email', now: saturdayAfternoon, schedule: workingHours })

    expect(result.decision).toBe('hold')
    expect(result.because).toBe('quiet-hours')
    // Saturday 14:00 to Monday 09:00.
    expect(result.deliverAtMs).toBe(saturdayAfternoon.epochMs + 43 * 60 * 60_000)
  })

  test('the inbox is never held, whatever the hour', () => {
    const result = deliveryDecision({ channel: 'in_app', now: saturdayAfternoon, schedule: workingHours })

    expect(result.decision).toBe('send')
  })

  test('a muted subject still reaches the inbox, marked muted', () => {
    // This is what makes muting safe enough to use instead of leaving.
    const result = deliveryDecision({ channel: 'in_app', now: tuesdayAfternoon, muted: true })

    expect(result.decision).toBe('send')
    expect(result.because).toBe('muted')
  })

  test('a muted subject is dropped on the interrupting channels', () => {
    const result = deliveryDecision({ channel: 'push', now: tuesdayAfternoon, muted: true })

    expect(result.decision).toBe('drop')
    expect(result.because).toBe('muted')
  })

  test('muting outranks the clock, so a muted subject is dropped rather than held', () => {
    // There is no hour at which somebody wants the repository they muted.
    const result = deliveryDecision({
      channel: 'push',
      now: saturdayAfternoon,
      schedule: workingHours,
      muted: true,
    })

    expect(result.decision).toBe('drop')
  })

  test('a break-through event ignores the schedule', () => {
    const result = deliveryDecision({
      channel: 'push',
      now: saturdayAfternoon,
      schedule: workingHours,
      breaksThrough: true,
    })

    expect(result.decision).toBe('send')
    expect(result.because).toBe('breaks-through')
  })

  test('a break-through event does not override an explicit mute', () => {
    const result = deliveryDecision({
      channel: 'push',
      now: tuesdayAfternoon,
      muted: true,
      breaksThrough: true,
    })

    expect(result.decision).toBe('drop')
  })

  test('do not disturb holds until it expires', () => {
    const until = tuesdayAfternoon.epochMs + 3_600_000
    const result = deliveryDecision({ channel: 'push', now: tuesdayAfternoon, doNotDisturbUntilMs: until })

    expect(result.decision).toBe('hold')
    expect(result.deliverAtMs).toBe(until)
    expect(result.because).toBe('do-not-disturb')
  })

  test('an expired do not disturb stops applying by itself', () => {
    const result = deliveryDecision({
      channel: 'push',
      now: tuesdayAfternoon,
      doNotDisturbUntilMs: tuesdayAfternoon.epochMs - 1,
    })

    expect(result.decision).toBe('send')
  })

  test('no schedule means unconstrained', () => {
    expect(deliveryDecision({ channel: 'push', now: saturdayAfternoon }).decision).toBe('send')
  })

  test('a schedule with no days does not silence everything forever', () => {
    // Holding indefinitely is the worst failure mode this can have, and an
    // empty day list is never what somebody meant.
    const result = deliveryDecision({
      channel: 'push',
      now: saturdayAfternoon,
      schedule: { days: [], startsAt: 9 * 60, endsAt: 18 * 60 },
    })

    expect(result.decision).toBe('send')
  })

  test('a night shift is reachable at 23:00 on a working day', () => {
    const result = deliveryDecision({ channel: 'push', now: tuesdayNight, schedule: nightShift })

    expect(result.decision).toBe('send')
  })
})

describe('muteApplies', () => {
  test('a null expiry is indefinite', () => {
    expect(muteApplies({ expiresAt: null }, 1_700_000_000_000)).toBe(true)
  })

  test('a mute in the future still applies', () => {
    expect(muteApplies({ expiresAt: 1_700_000_001_000 }, 1_700_000_000_000)).toBe(true)
  })

  test('a mute ends by itself', () => {
    expect(muteApplies({ expiresAt: 1_699_999_999_000 }, 1_700_000_000_000)).toBe(false)
  })

  test('no mute at all', () => {
    expect(muteApplies(null, 1_700_000_000_000)).toBe(false)
  })
})

describe('decisionText', () => {
  test('explains a hold in words somebody can act on', () => {
    const outcome = deliveryDecision({ channel: 'email', now: saturdayAfternoon, schedule: workingHours })

    expect(decisionText(outcome)).toBe('it would wait until your next window opens')
  })

  test('distinguishes a muted inbox entry from a dropped push', () => {
    const inbox = deliveryDecision({ channel: 'in_app', now: tuesdayAfternoon, muted: true })
    const push = deliveryDecision({ channel: 'push', now: tuesdayAfternoon, muted: true })

    expect(decisionText(inbox)).toBe('it would go to your inbox, marked muted')
    expect(decisionText(push)).toBe('it would be dropped, because you muted this')
  })
})
