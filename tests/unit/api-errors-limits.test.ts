/**
 * Errors a program can act on, and limits it can pace itself against.
 *
 * Both are about the same failure: a client that is told something went wrong
 * but not what to do next has only bad options - give up, retry forever, or
 * guess. The third is the one that fills an issue tracker with near-miss
 * attempts.
 */

import { describe, expect, it } from 'bun:test'
import { apiError, ERROR_CODES, invalidField, missingField } from '../../app/Api/errors'
import {
  bucketFor,
  check,
  DEFAULT_READ_LIMIT,
  DEFAULT_WRITE_LIMIT,
  headers,
  type Limit,
} from '../../app/Api/rate-limit'

async function bodyOf(answer: Response): Promise<any> {
  return await answer.json()
}

describe('errors', () => {
  it('takes its status from the code, so the two cannot disagree', async () => {
    // A not_found answered with a 200 is the kind of thing that only shows up
    // when somebody's retry loop never terminates.
    expect(apiError('not_found', 'no such pull request').status).toBe(404)
    expect(apiError('forbidden', 'nope').status).toBe(403)
    expect(apiError('rate_limited', 'slow down', { retryAfter: 30 }).status).toBe(429)
  })

  it('carries a stable code to branch on, separate from the prose', async () => {
    /*
     * The code is the only part a client should key on. Messages get reworded,
     * translated and improved; a client keyed on the prose breaks when somebody
     * fixes a typo.
     */
    const body = await bodyOf(apiError('conflict', 'the base branch moved'))

    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('the base branch moved')
  })

  it('names the field and says what to do', async () => {
    const body = await bodyOf(missingField('title', 'Send a title of at least one character.'))

    expect(body.error.field).toBe('title')
    // Not a restatement of the rule. "must match ^[a-z]" says what failed, not
    // what to do about it.
    expect(body.error.fix).toContain('Send a title')
  })

  it('and does the same for a field that is present and wrong', async () => {
    const body = await bodyOf(invalidField('visibility', 'unknown visibility', 'Use public or private.'))

    expect(body.error.code).toBe('invalid_field')
    expect(body.error.field).toBe('visibility')
    expect(body.error.fix).toContain('public or private')
  })

  it('puts Retry-After in the header as well as the body', async () => {
    /*
     * A client using a generic HTTP layer reads the header; one written against
     * this API reads the body. Sending only one means half of them busy-loop.
     */
    const answer = apiError('rate_limited', 'too many', { retryAfter: 42 })

    expect(answer.headers.get('retry-after')).toBe('42')
    expect((await bodyOf(answer)).error.retryAfter).toBe(42)
  })

  it('never sends a Retry-After below one second', async () => {
    // Zero invites an immediate retry, which is the behaviour being limited.
    expect(apiError('rate_limited', 'x', { retryAfter: 0.2 }).headers.get('retry-after')).toBe('1')
  })

  it('omits field and fix rather than sending empty ones', async () => {
    // An empty string reads as "there is a field and it is unnamed", which is
    // worse than the key being absent.
    const body = await bodyOf(apiError('internal', 'something broke'))

    expect(body.error.field).toBeUndefined()
    expect(body.error.fix).toBeUndefined()
  })

  it('has a status for every code, which is what makes the set safe to exhaust', () => {
    for (const [code, status] of Object.entries(ERROR_CODES)) {
      expect(typeof status).toBe('number')
      expect(apiError(code as any, 'x').status).toBe(status)
    }
  })
})

describe('rate limits', () => {
  const limit: Limit = { max: 3, windowMs: 60_000 }
  const start = 1_000_000

  it('allows a request inside the budget and counts what is left after it', () => {
    /*
     * After, not before. A client told it has 1 remaining sends one more and is
     * refused, which makes the number useless for pacing - and pacing is the
     * entire reason to publish it.
     */
    const verdict = check(limit, { used: 0, windowStartedMs: start }, start + 1000)

    expect(verdict.allowed).toBe(true)
    expect(verdict.remaining).toBe(2)
  })

  it('refuses once the budget is spent, with nothing remaining', () => {
    const verdict = check(limit, { used: 3, windowStartedMs: start }, start + 1000)

    expect(verdict.allowed).toBe(false)
    expect(verdict.remaining).toBe(0)
  })

  it('reports a Retry-After that is actually true', () => {
    /*
     * The window has 40 seconds left, so that is what is sent. A fixed 60 is a
     * guess, and a client that trusts a guess and retries into another
     * rejection learns to ignore the header.
     */
    const verdict = check(limit, { used: 3, windowStartedMs: start }, start + 20_000)

    expect(verdict.retryAfterSeconds).toBe(40)
  })

  it('never reports a Retry-After of zero when refusing', () => {
    // At the very last millisecond the honest answer rounds to zero, which
    // invites an immediate retry into the same rejection.
    const verdict = check(limit, { used: 3, windowStartedMs: start }, start + 59_999)

    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('starts a fresh window once the old one has run out', () => {
    const verdict = check(limit, { used: 3, windowStartedMs: start }, start + 60_001)

    expect(verdict.allowed).toBe(true)
    expect(verdict.remaining).toBe(2)
    expect(verdict.retryAfterSeconds).toBe(0)
  })

  it('publishes the budget on every response, not only the rejection', () => {
    /*
     * A client that only learns its budget when it runs out cannot pace itself,
     * only recover. Publishing a limit is pointless unless a well-behaved
     * client can stay under it.
     */
    const verdict = check(limit, { used: 1, windowStartedMs: start }, start + 1000)
    const sent = headers(limit, verdict)

    expect(sent['X-RateLimit-Limit']).toBe('3')
    expect(sent['X-RateLimit-Remaining']).toBe('1')
    expect(Number(sent['X-RateLimit-Reset'])).toBeGreaterThan(start / 1000)
  })
})

describe('the bucket', () => {
  it('is the token, so one agent looping cannot spend another agent\'s budget', () => {
    /*
     * A shared per-account bucket means the first bad retry loop takes
     * everything down with it - and the first bad loop is never malice, it is a
     * retry with no backoff.
     */
    expect(bucketFor({ tokenId: 5, userId: 9 })).toBe('token:5')
    expect(bucketFor({ tokenId: 6, userId: 9 })).not.toBe(bucketFor({ tokenId: 5, userId: 9 }))
  })

  it('falls back to the account, then to the address', () => {
    expect(bucketFor({ userId: 9 })).toBe('user:9')
    expect(bucketFor({ ip: '203.0.113.1' })).toBe('ip:203.0.113.1')
  })

  it('has something to key on even with nothing to go on', () => {
    // Otherwise an unauthenticated request with no address bypasses the limit
    // entirely, which is the one caller most likely to be a flood.
    expect(bucketFor({})).toBe('ip:unknown')
  })
})

describe('the defaults', () => {
  it('are generous for reads, because the design asks clients to poll', () => {
    /*
     * The whole design encourages polling and then makes it free with ETag. A
     * limit that punishes the behaviour the API asks for would be incoherent.
     */
    expect(DEFAULT_READ_LIMIT.max).toBeGreaterThan(DEFAULT_WRITE_LIMIT.max * 10)
  })

  it('and much tighter for writes, where a loop does proportional damage', () => {
    // A thousand reads are invisible. A thousand comments are somebody's
    // afternoon.
    expect(DEFAULT_WRITE_LIMIT.max).toBeLessThan(1000)
  })
})
