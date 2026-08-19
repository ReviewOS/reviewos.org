// Deciding, after the fact, whether a recorded push happened.
//
// A row is written pending before a push is allowed and committed when
// post-receive says it landed; anything that dies between the two leaves a row
// that is neither true nor false. The rule below is what settles them, and it
// is pure so it can be tested without a repository - the queries around it are
// the easy part.

import { describe, expect, test } from 'bun:test'
import { entryVerdict, verdictFor } from '../../app/Actions/Git/walReconcile'

const ZERO = '0'.repeat(40)
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const LATER = 'c'.repeat(40)

describe('verdictFor', () => {
  test('the ref points where the entry said: landed', () => {
    expect(verdictFor(
      { ref: 'refs/heads/main', before: OLD, after: NEW },
      { tip: NEW, knowsAfter: true },
    )).toBe('landed')
  })

  /**
   * The case that decides whether this is usable at all. Every entry but the
   * newest has been built on by a later push, so a rule that only accepted an
   * exact tip match would void almost the whole log.
   */
  test('a later push moved the ref on, but the objects are here: landed', () => {
    expect(verdictFor(
      { ref: 'refs/heads/main', before: OLD, after: NEW },
      { tip: LATER, knowsAfter: true },
    )).toBe('landed')
  })

  test('the repository has never heard of the sha: abandoned', () => {
    expect(verdictFor(
      { ref: 'refs/heads/main', before: OLD, after: NEW },
      { tip: OLD, knowsAfter: false },
    )).toBe('abandoned')
  })

  test('a deletion that took: landed', () => {
    expect(verdictFor(
      { ref: 'refs/heads/gone', before: OLD, after: ZERO },
      { tip: null, knowsAfter: false },
    )).toBe('landed')
  })

  test('a deletion whose ref is still there: abandoned', () => {
    expect(verdictFor(
      { ref: 'refs/heads/gone', before: OLD, after: ZERO },
      { tip: OLD, knowsAfter: true },
    )).toBe('abandoned')
  })

  test('a sha that is not a sha is unknown rather than a guess', () => {
    expect(verdictFor(
      { ref: 'refs/heads/main', before: OLD, after: 'not-a-sha' },
      { tip: OLD, knowsAfter: false },
    )).toBe('unknown')
  })
})

describe('entryVerdict', () => {
  test('a push is atomic, so all or nothing decides it', () => {
    expect(entryVerdict(['landed', 'landed'])).toBe('landed')
    expect(entryVerdict(['abandoned', 'abandoned'])).toBe('abandoned')
  })

  /**
   * A mixed answer is not "half landed" - it is a state that should be
   * impossible, and acting on it automatically is how a reconciler corrupts a
   * log. It stays pending for a person.
   */
  test('a mixed answer stays unknown rather than being resolved', () => {
    expect(entryVerdict(['landed', 'abandoned'])).toBe('unknown')
    expect(entryVerdict(['landed', 'unknown'])).toBe('unknown')
  })

  test('an entry with no updates is unknown, never landed', () => {
    expect(entryVerdict([])).toBe('unknown')
  })
})
