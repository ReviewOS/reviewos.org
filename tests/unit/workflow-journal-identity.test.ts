// What makes a call the same call.
//
// This decides whether a replay hands back a recorded answer or declares the
// workflow non-deterministic, so both directions are expensive to get wrong: a
// false match returns one call's result to a different call, and a false
// mismatch fails a run that was fine.

import { describe, expect, test } from 'bun:test'
import { canonical, identityOf, overWallTime, DEFAULT_BUDGETS } from '../../app/Actions/Workflow/journal'

describe('canonical rendering', () => {
  /**
   * The one that would break every replay if it were missing. A program built
   * from a `Record` has no key-order guarantee across engines, so two
   * renderings of the same arguments must not read as two different calls -
   * otherwise a journal reports divergence on every restart and durability is
   * a feature that never works.
   */
  test('object key order does not change the answer', () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
    expect(identityOf('step', 'build', { b: 1, a: 2 })).toBe(identityOf('step', 'build', { a: 2, b: 1 }))
  })

  test('but array order does, because a list is ordered by definition', () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]))
  })

  test('nested objects are normalized at every depth', () => {
    expect(canonical({ x: { b: 1, a: 2 } })).toBe(canonical({ x: { a: 2, b: 1 } }))
  })

  test('undefined is dropped, so an absent key and an undefined one agree', () => {
    // `{ a: 1 }` and `{ a: 1, b: undefined }` are the same call: JSON cannot
    // carry the difference, so treating them as different would report a
    // divergence that survives no round trip anyway.
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }))
  })

  test('null is not dropped, because null is a value somebody passed', () => {
    expect(canonical({ a: 1, b: null })).not.toBe(canonical({ a: 1 }))
  })
})

describe('identity', () => {
  test('the same call is the same identity, every time', () => {
    expect(identityOf('step', 'build', { target: 'x' })).toBe(identityOf('step', 'build', { target: 'x' }))
  })

  test('a different name, a different argument, or a different kind is a different call', () => {
    const base = identityOf('step', 'build', { target: 'x' })

    expect(identityOf('step', 'test', { target: 'x' })).not.toBe(base)
    expect(identityOf('step', 'build', { target: 'y' })).not.toBe(base)
    expect(identityOf('sleep', 'build', { target: 'x' })).not.toBe(base)
  })

  test('and it is a sha-256, so it fits the column and says nothing about the arguments', () => {
    expect(identityOf('step', 'build', { token: 'a-secret-somebody-passed' })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the wall-time budget', () => {
  /**
   * Checked outside `record` because it is the one budget that is not about a
   * call: a workflow sleeping for a week makes no calls while it does it, and a
   * limit only checked on the next call is not a limit.
   */
  test('is measured from the start, not from the last call', () => {
    const started = new Date('2026-08-19T00:00:00.000Z')

    expect(overWallTime(started, started.getTime() + DEFAULT_BUDGETS.maxWallMs - 1)).toBe(false)
    expect(overWallTime(started, started.getTime() + DEFAULT_BUDGETS.maxWallMs + 1)).toBe(true)
  })

  test('a run with no start time is not killed on the strength of a value nobody can read', () => {
    expect(overWallTime(null, Date.now())).toBe(false)
    expect(overWallTime('not a date', Date.now())).toBe(false)
  })
})
