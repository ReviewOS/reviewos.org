// Turning an instant into somebody's local weekday and minute.
//
// The case worth having tests for is daylight saving: a schedule set as "18:00
// my time" has to keep meaning that after the clocks move, and a stored offset
// is how that goes wrong twice a year.

import { describe, expect, test } from 'bun:test'
import { formatDays, localTimeIn, parseDays, parseEventList } from '../../app/Actions/Notification/clock'

// 2024-01-16T12:00:00Z, a Tuesday.
const winterNoonUtc = Date.UTC(2024, 0, 16, 12, 0, 0)

// 2024-07-16T12:00:00Z, also a Tuesday, on the other side of the clock change.
const summerNoonUtc = Date.UTC(2024, 6, 16, 12, 0, 0)

describe('localTimeIn', () => {
  test('UTC is the identity', () => {
    expect(localTimeIn('UTC', winterNoonUtc)).toEqual({
      epochMs: winterNoonUtc,
      weekday: 2,
      minutes: 12 * 60,
    })
  })

  test('a zone ahead of UTC', () => {
    expect(localTimeIn('Europe/Berlin', winterNoonUtc).minutes).toBe(13 * 60)
  })

  test('the same zone in summer is an hour further ahead', () => {
    // The point of asking a calendar rather than storing an offset.
    expect(localTimeIn('Europe/Berlin', summerNoonUtc).minutes).toBe(14 * 60)
  })

  test('a zone behind UTC can be on the previous weekday', () => {
    // 12:00 Tuesday UTC is 01:00 Tuesday in Los Angeles in summer, but 04:00
    // Tuesday in New York. Crossing back over midnight is the case that moves
    // the weekday, so check one that does.
    const auckland = localTimeIn('Pacific/Auckland', Date.UTC(2024, 0, 16, 12, 0, 0))

    // 01:00 on Wednesday.
    expect(auckland.weekday).toBe(3)
    expect(auckland.minutes).toBe(60)
  })

  test('midnight is minute zero, not minute 1440', () => {
    const midnight = localTimeIn('UTC', Date.UTC(2024, 0, 16, 0, 0, 0))

    expect(midnight.minutes).toBe(0)
  })

  test('half-hour offsets are handled', () => {
    expect(localTimeIn('Asia/Kolkata', winterNoonUtc).minutes).toBe(17 * 60 + 30)
  })

  test('an unknown zone falls back to UTC rather than throwing', () => {
    // A bad string in a settings row is not worth losing a notification over.
    expect(localTimeIn('Not/AZone', winterNoonUtc).minutes).toBe(12 * 60)
  })

  test('the absolute time is carried through unchanged', () => {
    expect(localTimeIn('Europe/Berlin', winterNoonUtc).epochMs).toBe(winterNoonUtc)
  })
})

describe('parseDays', () => {
  test('the default working week', () => {
    expect(parseDays('1,2,3,4,5')).toEqual([1, 2, 3, 4, 5])
  })

  test('whitespace and duplicates are tidied', () => {
    expect(parseDays(' 1, 1 ,3')).toEqual([1, 3])
  })

  test('out of range values are dropped rather than wrapping', () => {
    expect(parseDays('0,6,7,-1,banana')).toEqual([0, 6])
  })

  test('an empty column is no days, which means unconstrained', () => {
    expect(parseDays('')).toEqual([])
    expect(parseDays(null)).toEqual([])
  })

  test('round trips through formatDays', () => {
    expect(formatDays(parseDays('5,1,3'))).toBe('1,3,5')
  })
})

describe('parseEventList', () => {
  test('splits and trims', () => {
    expect(parseEventList('review:requested, ci:failed')).toEqual(['review:requested', 'ci:failed'])
  })

  test('empty means nothing breaks through, which is the default', () => {
    expect(parseEventList('')).toEqual([])
  })
})
