// When to try a failed step again.
//
// Pure on purpose: a retry schedule that can only be checked by waiting for it
// is one nobody tests, and the thing worth testing is that an exponential
// backoff does not quietly become a delay of four years on attempt thirty.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_POLICY, delayFor, policyFrom, scheduleOf, shouldRetry } from '../../app/Actions/Workflow/retryPolicy'

const base = { attempts: 4, delayMs: 1000, maxDelayMs: 60_000, exitStatuses: [] as number[] }

describe('the three shapes', () => {
  test('constant waits the same every time', () => {
    const policy = { ...base, backoff: 'constant' as const }

    expect([2, 3, 4].map(one => delayFor(policy, one))).toEqual([1000, 1000, 1000])
  })

  test('linear grows by the base each time', () => {
    const policy = { ...base, backoff: 'linear' as const }

    expect([2, 3, 4].map(one => delayFor(policy, one))).toEqual([1000, 2000, 3000])
  })

  test('exponential doubles', () => {
    const policy = { ...base, backoff: 'exponential' as const }

    expect([2, 3, 4].map(one => delayFor(policy, one))).toEqual([1000, 2000, 4000])
  })

  test('the first attempt never waits, whatever the shape', () => {
    for (const backoff of ['constant', 'linear', 'exponential'] as const)
      expect(delayFor({ ...base, backoff }, 1)).toBe(0)
  })
})

describe('the ceiling', () => {
  test('caps a delay that would otherwise run away', () => {
    const policy = { ...base, backoff: 'exponential' as const, maxDelayMs: 5000 }

    expect(delayFor(policy, 10)).toBe(5000)
  })

  /**
   * The one worth having a test for. Without the cap on the exponent, attempt
   * thirty is `1000 * 2 ** 29` - about seventeen days - and attempt sixty is a
   * number large enough that the arithmetic stops meaning anything.
   */
  test('and a very high attempt number does not overflow into nonsense', () => {
    const policy = { ...base, backoff: 'exponential' as const, maxDelayMs: 60_000 }

    expect(delayFor(policy, 60)).toBe(60_000)
    expect(Number.isFinite(delayFor(policy, 500))).toBe(true)
  })
})

describe('jitter', () => {
  /**
   * A matrix of twenty jobs failing against one flaky dependency retries at the
   * same instant twenty times over, and the synchronized herd is often what
   * keeps the dependency down.
   */
  test('spreads downward, never past the stated delay', () => {
    const policy = { ...base, backoff: 'constant' as const }

    expect(delayFor(policy, 2, 1)).toBe(1000)
    expect(delayFor(policy, 2, 0)).toBe(800)
    // Never above: spreading upward would let a retry push itself past a
    // timeout somebody set against the stated delay.
    expect(delayFor(policy, 2, 99)).toBe(1000)
  })
})

describe('which failures are retried', () => {
  test('any of them, when the workflow named none', () => {
    const policy = { ...base, backoff: 'constant' as const }

    expect(shouldRetry(policy, 1, 1)).toBe(true)
    expect(shouldRetry(policy, 1, null)).toBe(true)
  })

  test('only the named ones, when it named some', () => {
    // 137 is a machine that ran out of memory and is worth another try; 1 is a
    // test that failed and will fail again.
    const policy = { ...base, backoff: 'constant' as const, exitStatuses: [137] }

    expect(shouldRetry(policy, 1, 137)).toBe(true)
    expect(shouldRetry(policy, 1, 1)).toBe(false)
  })

  test('and a failure with no recorded status is not guessed at', () => {
    const policy = { ...base, backoff: 'constant' as const, exitStatuses: [137] }

    expect(shouldRetry(policy, 1, null)).toBe(false)
  })

  test('never past the limit', () => {
    const policy = { ...base, backoff: 'constant' as const }

    expect(shouldRetry(policy, 3, 1)).toBe(true)
    expect(shouldRetry(policy, 4, 1)).toBe(false)
  })
})

describe('reading a policy from a workflow', () => {
  test('a stanza with nothing in it is the default', () => {
    expect(policyFrom({})).toEqual(DEFAULT_POLICY)
    expect(policyFrom(null)).toEqual(DEFAULT_POLICY)
  })

  test('and one with a typo falls back rather than failing the run', () => {
    // A workflow whose retry stanza is wrong should still run; it just should
    // not retry in some way nobody asked for.
    const policy = policyFrom({ attempts: 'twice', backoff: 'fibonacci', delay: 'soon' })

    expect(policy.attempts).toBe(DEFAULT_POLICY.attempts)
    expect(policy.backoff).toBe(DEFAULT_POLICY.backoff)
    expect(policy.delayMs).toBe(DEFAULT_POLICY.delayMs)
  })

  test('attempts are bounded at both ends', () => {
    // Zero would mean "never run it", which is not what anybody writing
    // `retry:` meant, and a thousand is a loop with extra steps.
    expect(policyFrom({ attempts: 0 }).attempts).toBe(1)
    expect(policyFrom({ attempts: 1000 }).attempts).toBe(10)
  })

  test('and the keys people actually write are all accepted', () => {
    const policy = policyFrom({ 'attempts': 3, 'delay': 2000, 'backoff': 'linear', 'max-delay': 9000, 'exit-status': [137, 143] })

    expect(policy).toEqual({ attempts: 3, delayMs: 2000, backoff: 'linear', maxDelayMs: 9000, exitStatuses: [137, 143] })
  })
})

describe('the schedule', () => {
  /**
   * A person deciding whether a policy is sane should be able to read what it
   * will do rather than simulate it in their head.
   */
  test('says what the waits will be, in order', () => {
    expect(scheduleOf({ ...base, attempts: 3, backoff: 'exponential' })).toEqual([1000, 2000])
    expect(scheduleOf({ ...base, attempts: 1, backoff: 'exponential' })).toEqual([])
  })
})
