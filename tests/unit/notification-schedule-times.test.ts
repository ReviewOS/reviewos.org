// A time, in either of the two spellings its two callers can send.
//
// The column stores a minute from midnight, which is what the API documents
// and sends: `{"starts_at": 540}`. The settings form cannot send that. Its
// field is `<input type="time">`, because a clock is what a person should be
// given for "when may this interrupt me" rather than arithmetic, and that
// element sends `09:00` and nothing else.
//
// Only the minute was read, so the form's own value came back
// "A time is a minute from midnight, 0 to 1439" every time anybody pressed
// Save hours - one of three independent faults on that form, none of which
// could be seen without posting the body the page really posts.

import { describe, expect, test } from 'bun:test'
import { minute } from '../../app/Actions/Notification/UpdateScheduleAction'

const FALLBACK = 540

describe('a clock time, as the form sends it', () => {
  test('midnight, noon, and the ends of the day', () => {
    expect(minute('00:00', FALLBACK)).toBe(0)
    expect(minute('12:00', FALLBACK)).toBe(720)
    expect(minute('23:59', FALLBACK)).toBe(1439)
  })

  test('the hours the field offers by default', () => {
    expect(minute('09:00', FALLBACK)).toBe(540)
    expect(minute('17:00', FALLBACK)).toBe(1020)
    expect(minute('18:30', FALLBACK)).toBe(1110)
  })

  test('with seconds, which some browsers add', () => {
    // `step` can make the control send `HH:MM:SS`. The seconds are not stored,
    // and refusing the value over them would be a refusal nobody could act on.
    expect(minute('09:00:00', FALLBACK)).toBe(540)
    expect(minute('23:59:59', FALLBACK)).toBe(1439)
  })

  test('and a single-digit hour', () => {
    expect(minute('9:05', FALLBACK)).toBe(545)
  })

  test('surrounding whitespace is not a refusal', () => {
    expect(minute('  09:00  ', FALLBACK)).toBe(540)
  })
})

describe('a minute from midnight, as the API sends it', () => {
  test('the documented shape still works', () => {
    expect(minute(540, FALLBACK)).toBe(540)
    expect(minute('540', FALLBACK)).toBe(540)
    expect(minute(0, FALLBACK)).toBe(0)
    expect(minute(1439, FALLBACK)).toBe(1439)
  })
})

describe('what is absent, and what is wrong', () => {
  test('absent keeps what was already stored', () => {
    expect(minute(undefined, FALLBACK)).toBe(FALLBACK)
    expect(minute(null, FALLBACK)).toBe(FALLBACK)
    expect(minute('', FALLBACK)).toBe(FALLBACK)
  })

  test('a clock time that is not one is refused, not clamped', () => {
    // Clamping would store a time somebody did not choose and then show it
    // back to them as though they had.
    expect(minute('25:00', FALLBACK)).toBeNull()
    expect(minute('12:60', FALLBACK)).toBeNull()
    expect(minute('24:00', FALLBACK)).toBeNull()
  })

  test('a minute out of range is refused', () => {
    expect(minute(1440, FALLBACK)).toBeNull()
    expect(minute(-1, FALLBACK)).toBeNull()
    expect(minute(90.5, FALLBACK)).toBeNull()
  })

  test('and anything that is neither', () => {
    expect(minute('breakfast', FALLBACK)).toBeNull()
    expect(minute('09:00am', FALLBACK)).toBeNull()
    expect(minute('09-00', FALLBACK)).toBeNull()
    expect(minute({}, FALLBACK)).toBeNull()
  })
})
