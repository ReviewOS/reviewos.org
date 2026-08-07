// What the settings page is told about a key.
//
// The shaping is here rather than in the template because two of the decisions
// are judgements. **The public key body is never sent to the page**: it is
// public, so nothing leaks by it, but six keys listed in full is unreadable and
// the fingerprint is what a person compares against `ssh-keygen -l`. And
// expiry is computed on read rather than stored, because a key expires by the
// calendar - a column saying "expired" is wrong from the moment it is written
// until something happens to rewrite it.

import { describe, expect, test } from 'bun:test'
import { hasExpired } from '../../app/Actions/Keys/load'

describe('hasExpired', () => {
  test('a key with no expiry never expires', () => {
    expect(hasExpired(null)).toBe(false)
  })

  test('a date in the past has', () => {
    expect(hasExpired('2020-01-01T00:00:00.000Z')).toBe(true)
  })

  test('a date in the future has not', () => {
    expect(hasExpired('2999-01-01T00:00:00.000Z')).toBe(false)
  })

  test('the boundary counts as expired', () => {
    // A key whose expiry is exactly now is one gpg will refuse, so the
    // interface must not claim otherwise.
    const now = new Date('2026-01-01T00:00:00.000Z')

    expect(hasExpired('2026-01-01T00:00:00.000Z', now)).toBe(true)
  })

  test('an unreadable date is not treated as expired', () => {
    // Guessing "expired" from a value nobody can parse marks a working key as
    // dead. The row is shown, and the verification still decides.
    expect(hasExpired('not a date')).toBe(false)
  })
})
