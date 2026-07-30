/**
 * Signing webhook deliveries, and deciding when to give up on one.
 *
 * The signature is what lets a receiver believe a payload came from here. It is
 * computed over the exact bytes sent, because a receiver that re-serialises the
 * JSON before checking will compute a different digest for the same object and
 * conclude, correctly from its point of view, that the delivery is forged.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The header a receiver checks. */
export const SIGNATURE_HEADER = 'x-reviewos-signature-256'
export const EVENT_HEADER = 'x-reviewos-event'
export const DELIVERY_HEADER = 'x-reviewos-delivery'

/**
 * The signature for a payload, as `sha256=<hex>`.
 *
 * Takes the body as a string rather than an object so the caller cannot sign
 * one serialisation and send another.
 */
export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/**
 * Whether a signature matches, compared in constant time.
 *
 * A plain `===` on a digest leaks how many leading bytes were right, which is
 * enough to recover the whole signature one byte at a time.
 */
export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = signPayload(body, secret)

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature ?? '', 'utf8')

  // timingSafeEqual throws on a length mismatch, which is itself a leak of the
  // length. The lengths are fixed here, so a mismatch is simply wrong.
  if (a.length !== b.length)
    return false

  return timingSafeEqual(a, b)
}

/** How many times a delivery is attempted before the webhook is left alone. */
export const MAX_ATTEMPTS = 6

/**
 * How long to wait before attempt `attempt` (1-based, so attempt 1 is
 * immediate).
 *
 * Exponential with a ceiling, and jittered. Without jitter, a receiver that
 * goes down takes every pending delivery with it and they all come back at the
 * same instant, which is how a struggling endpoint is kept down.
 */
export function retryDelayMs(attempt: number, jitter = Math.random()): number {
  if (attempt <= 1)
    return 0

  const base = Math.min(2 ** (attempt - 1) * 1000, 60 * 60 * 1000)

  // Full jitter over the lower half, so the spread never delays past the cap.
  return Math.round(base * (0.5 + jitter * 0.5))
}

export interface DeliveryOutcome {
  status: number | null
  /** Set when the request never completed: timeout, DNS failure, refused. */
  error?: string
}

/**
 * Whether a failed delivery is worth attempting again.
 *
 * A 4xx means the receiver understood and refused, so repeating it changes
 * nothing; 408 and 429 are the exceptions, being explicitly "later". Anything
 * that never reached a server is worth another try.
 */
export function shouldRetry(outcome: DeliveryOutcome, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS)
    return false

  if (outcome.status === null)
    return true

  if (outcome.status >= 200 && outcome.status < 300)
    return false

  if (outcome.status === 408 || outcome.status === 429)
    return true

  return outcome.status >= 500
}

/**
 * Whether a webhook has failed for long enough to be switched off.
 *
 * Kept separate from the retry decision: one delivery giving up is normal, a
 * webhook that has not succeeded in days is an endpoint nobody owns any more,
 * and continuing to call it is a slow outbound attack on somebody's server.
 */
export function shouldDeactivate(input: {
  consecutiveFailures: number
  daysSinceLastSuccess: number | null
}): boolean {
  if (input.consecutiveFailures < 20)
    return false

  // Never delivered at all is not evidence of abandonment on its own; it is
  // usually an endpoint that was never finished.
  if (input.daysSinceLastSuccess === null)
    return input.consecutiveFailures >= 50

  return input.daysSinceLastSuccess >= 7
}
