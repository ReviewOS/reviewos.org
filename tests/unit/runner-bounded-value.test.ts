// An output too large for the store, handled rather than shortened.
//
// The failure this prevents is a quiet one. A truncated value looks like it
// worked: the row holds a string, the screen shows a string, and the job that
// reads it fails somewhere else entirely on a line that has nothing to do with
// the cause.

import { describe, expect, test } from 'bun:test'
import { boundedValue } from '../../app/Actions/Runner/report'

describe('a value that fits', () => {
  test('is kept exactly as it is', () => {
    expect(boundedValue('app.tar.gz', 4000)).toBe('app.tar.gz')
  })

  test('including one that is exactly the limit', () => {
    const value = 'x'.repeat(100)

    expect(boundedValue(value, 100)).toBe(value)
  })
})

describe('a value that does not', () => {
  test('is replaced by something obviously not the value', () => {
    const dropped = boundedValue('x'.repeat(5000), 4000)

    // Not a prefix of the original. A reader that got the first four thousand
    // characters of a JSON document has something that parses as far as it
    // goes and then does not, which is the worst of both.
    expect(dropped.startsWith('xxxx')).toBe(false)
    expect(dropped).toContain('dropped')
  })

  test('and says how big it was and what to do instead', () => {
    const dropped = boundedValue('x'.repeat(5000), 4000)

    // The size, so somebody can tell a value that is slightly over from one
    // that was never going to fit.
    expect(dropped).toContain('5000')
    expect(dropped).toContain('4000')
    // And where the value belongs, rather than only that it does not belong
    // here.
    expect(dropped).toContain('artifact')
  })

  /**
   * Measured in bytes, not characters. A limit counted in characters lets a
   * value of emoji or CJK text through at several times the size the column
   * was sized for, which is how a bound becomes a suggestion.
   */
  test('measured in bytes rather than characters', () => {
    // Three bytes each in UTF-8.
    const wide = '日'.repeat(2000)

    expect(wide.length).toBe(2000)
    expect(boundedValue(wide, 4000)).toContain('dropped')
    expect(boundedValue(wide, 4000)).toContain('6000')
  })
})
