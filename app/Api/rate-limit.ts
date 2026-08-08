/**
 * Rate limits that are documented, always visible, and honest.
 *
 * Three properties, and each one is a complaint about how this is usually done:
 *
 * - **Headers on every response, not only the rejection.** A client that only
 *   learns its budget when it runs out cannot pace itself; it can only recover.
 *   The whole point of publishing a limit is to let a well-behaved client stay
 *   under it.
 * - **Per token, not per account.** One agent looping must not exhaust the
 *   budget of the person who issued it, or of the other three agents on the
 *   same account. A shared bucket means the first bad retry loop takes
 *   everything down with it - and the first bad loop is never malice, it is a
 *   retry with no backoff.
 * - **A `Retry-After` that is true.** A fixed 60 is a guess, and a client that
 *   trusts it and retries into another rejection learns to ignore it. The
 *   window's actual remaining time is knowable, so it is what gets sent.
 */

/** A fixed window, which is what makes `Retry-After` computable rather than guessed. */
export interface Limit {
  /** Requests allowed per window. */
  max: number
  windowMs: number
}

export interface Consumption {
  /** How many requests have landed in the current window. */
  used: number
  /** When the current window began. */
  windowStartedMs: number
}

export interface Verdict {
  allowed: boolean
  /** What is left after this request, floored at zero. */
  remaining: number
  /** When the window resets, as epoch seconds - the unit every forge uses. */
  resetAtSeconds: number
  /** Seconds until the window resets. Only meaningful when refused. */
  retryAfterSeconds: number
}

/**
 * Whether this request fits, and what to tell the client either way.
 *
 * Pure over the counter, so the sliding-window arithmetic - which is the part
 * that produces a wrong `Retry-After` - is testable without a clock or a store.
 */
export function check(limit: Limit, consumption: Consumption, nowMs: number = Date.now()): Verdict {
  const elapsed = nowMs - consumption.windowStartedMs

  // A window that has run out starts fresh, and this request is its first.
  if (elapsed >= limit.windowMs) {
    return {
      allowed: true,
      remaining: Math.max(0, limit.max - 1),
      resetAtSeconds: Math.ceil((nowMs + limit.windowMs) / 1000),
      retryAfterSeconds: 0,
    }
  }

  const resetAtMs = consumption.windowStartedMs + limit.windowMs
  const allowed = consumption.used < limit.max

  return {
    allowed,
    // After this request, which is what a client needs to decide whether to
    // send the next one. Reporting the count *before* it means a client with a
    // remaining of 1 sends one more and is refused.
    remaining: Math.max(0, limit.max - consumption.used - (allowed ? 1 : 0)),
    resetAtSeconds: Math.ceil(resetAtMs / 1000),
    // The real remaining time, rounded up so it is never optimistic. A
    // `Retry-After` a client trusts and is refused by is a `Retry-After`
    // clients learn to ignore.
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
  }
}

/**
 * The headers, for every response.
 *
 * `X-RateLimit-*` rather than the RFC 9331 `RateLimit-*`: every client library
 * written against a forge already reads these, and being standards-correct at
 * the cost of being unreadable to existing tooling is the wrong trade for a
 * surface whose whole purpose is compatibility.
 */
export function headers(limit: Limit, verdict: Verdict): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit.max),
    'X-RateLimit-Remaining': String(verdict.remaining),
    'X-RateLimit-Reset': String(verdict.resetAtSeconds),
  }
}

/**
 * The bucket a request counts against.
 *
 * The token when there is one, falling back to the account. Two agents on one
 * account get two budgets; a person clicking around the interface gets their
 * own, separate from either.
 */
export function bucketFor(input: { tokenId?: number | null, userId?: number | null, ip?: string | null }): string {
  if (input.tokenId)
    return `token:${input.tokenId}`

  if (input.userId)
    return `user:${input.userId}`

  /*
   * Signed out, so the address is all there is. Weakest of the three and
   * deliberately last: an address is shared by everybody behind one NAT, so a
   * limit keyed on it is a limit an office shares. It exists to stop an
   * unauthenticated flood, not to be fair.
   */
  return `ip:${input.ip ?? 'unknown'}`
}

/**
 * The default budgets.
 *
 * Reads are generous because the whole design encourages polling and then makes
 * it free with `ETag` - a 304 costs almost nothing to serve, and a limit that
 * punishes the behaviour the API asks for would be incoherent.
 *
 * Writes are much tighter, because the damage a runaway loop does is
 * proportional to what it creates: a thousand reads are invisible, a thousand
 * comments are somebody's afternoon.
 */
export const DEFAULT_READ_LIMIT: Limit = { max: 5000, windowMs: 60 * 60 * 1000 }
export const DEFAULT_WRITE_LIMIT: Limit = { max: 300, windowMs: 60 * 60 * 1000 }
