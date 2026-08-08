/**
 * Per-token creation budgets.
 *
 * The rule: **null means the instance default, and zero means zero.** Getting
 * that backwards in either direction is silent. Treating null as unlimited
 * leaves every token issued before this existed with no budget forever, and
 * those are precisely the ones running unattended; treating zero as unset does
 * the opposite of what an owner explicitly asked for.
 *
 * `spend` itself is exercised end to end in tests/e2e/token-limits.test.ts,
 * where there is a database to count in. What is here is the part that decides,
 * which is worth testing without one.
 */

import { describe, expect, it } from 'bun:test'
import { DEFAULT_LIMITS, limitFor, METERED_ACTIONS, spend } from '../../app/Api/token-limits'

describe('choosing the budget', () => {
  it('falls back to the instance default when a token names none', () => {
    expect(limitFor({ limit_comments_per_hour: null }, 'comments')).toEqual(DEFAULT_LIMITS.comments)
    expect(limitFor({}, 'comments')).toEqual(DEFAULT_LIMITS.comments)
    expect(limitFor(null, 'comments')).toEqual(DEFAULT_LIMITS.comments)
  })

  it('uses the token\'s own when it has one', () => {
    expect(limitFor({ limit_comments_per_hour: 5 }, 'comments').max).toBe(5)
  })

  it('honours zero as zero', () => {
    // "This token may not open pull requests" is a reasonable thing for an
    // owner to say, and the default is 20.
    expect(limitFor({ limit_pull_requests_per_hour: 0 }, 'pull_requests').max).toBe(0)
  })

  it('keeps the budgets separate', () => {
    // Forty comments an hour from a linting agent is a working configuration;
    // forty pull requests an hour is not. One number cannot express both.
    const token = { limit_comments_per_hour: 40, limit_pull_requests_per_hour: 2 }

    expect(limitFor(token, 'comments').max).toBe(40)
    expect(limitFor(token, 'pull_requests').max).toBe(2)
    expect(limitFor(token, 'reviews')).toEqual(DEFAULT_LIMITS.reviews)
  })

  it('ignores a value that is not a number', () => {
    // It arrives from a form field, and the cost of ignoring it is the default
    // budget - the same thing sending nothing does.
    expect(limitFor({ limit_reviews_per_hour: 'lots' }, 'reviews')).toEqual(DEFAULT_LIMITS.reviews)
    expect(limitFor({ limit_reviews_per_hour: -5 }, 'reviews')).toEqual(DEFAULT_LIMITS.reviews)
  })

  it('has a default for every action it meters', () => {
    // Otherwise an action added to the list is metered against `undefined`,
    // which reads as no limit.
    for (const action of METERED_ACTIONS)
      expect(DEFAULT_LIMITS[action]?.max).toBeGreaterThan(0)
  })

  it('meters pull requests far tighter than comments', () => {
    /*
     * Not arbitrary. A thorough reviewer leaves sixty comments in an hour;
     * nobody opens sixty pull requests in one on purpose. Pinning the ordering
     * rather than the numbers, so tuning them stays free and inverting them
     * does not.
     */
    expect(DEFAULT_LIMITS.pull_requests.max).toBeLessThan(DEFAULT_LIMITS.comments.max)
  })
})

describe('a request with no token', () => {
  it('is not metered here', async () => {
    // A browser session. Governed by the request-level limit instead, and
    // metering it would count a person's afternoon against a budget written
    // for a loop.
    const { verdict } = await spend(null, 'comments', null)

    expect(verdict.allowed).toBe(true)
  })
})
