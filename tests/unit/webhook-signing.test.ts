// Webhook signatures and delivery retries.
//
// The signature is checked against a fixed vector so a refactor that changes
// the digest is caught here rather than by every receiver at once.

import { describe, expect, test } from 'bun:test'
import {
  MAX_ATTEMPTS,
  retryDelayMs,
  shouldDeactivate,
  shouldRetry,
  signPayload,
  verifySignature,
} from '../../app/Actions/Webhook/signing'

describe('signPayload', () => {
  test('matches a known vector', () => {
    // HMAC-SHA256 of "Hello, World!" keyed with "It's a Secret to Everybody",
    // the vector published in GitHub's webhook documentation.
    const signature = signPayload('Hello, World!', 'It\'s a Secret to Everybody')

    expect(signature).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')
  })

  test('is prefixed with the algorithm, so it can change later', () => {
    expect(signPayload('{}', 'secret').startsWith('sha256=')).toBe(true)
  })

  test('a different body signs differently', () => {
    expect(signPayload('{"a":1}', 'secret')).not.toBe(signPayload('{"a":2}', 'secret'))
  })

  test('a different secret signs differently', () => {
    expect(signPayload('{}', 'one')).not.toBe(signPayload('{}', 'two'))
  })

  test('whitespace counts, because the receiver hashes the bytes it got', () => {
    expect(signPayload('{"a": 1}', 'secret')).not.toBe(signPayload('{"a":1}', 'secret'))
  })
})

describe('verifySignature', () => {
  test('accepts its own signature', () => {
    const body = '{"event":"ping"}'

    expect(verifySignature(body, 'secret', signPayload(body, 'secret'))).toBe(true)
  })

  test('rejects a signature for a different body', () => {
    expect(verifySignature('{"a":1}', 'secret', signPayload('{"a":2}', 'secret'))).toBe(false)
  })

  test('rejects a signature made with a different secret', () => {
    expect(verifySignature('{}', 'right', signPayload('{}', 'wrong'))).toBe(false)
  })

  test('rejects nonsense without throwing on the length mismatch', () => {
    expect(verifySignature('{}', 'secret', 'sha256=short')).toBe(false)
    expect(verifySignature('{}', 'secret', '')).toBe(false)
  })
})

describe('retryDelayMs', () => {
  test('the first attempt is immediate', () => {
    expect(retryDelayMs(1)).toBe(0)
  })

  test('backs off exponentially', () => {
    // Jitter pinned so the growth is what is being tested.
    expect(retryDelayMs(2, 1)).toBe(2000)
    expect(retryDelayMs(3, 1)).toBe(4000)
    expect(retryDelayMs(4, 1)).toBe(8000)
  })

  test('jitter spreads a retry over the lower half of the window', () => {
    expect(retryDelayMs(4, 0)).toBe(4000)
    expect(retryDelayMs(4, 1)).toBe(8000)
  })

  test('never waits longer than an hour', () => {
    expect(retryDelayMs(30, 1)).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  test('every delay is a whole number of milliseconds', () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)
      expect(Number.isInteger(retryDelayMs(attempt, 0.37))).toBe(true)
  })
})

describe('shouldRetry', () => {
  test('a success is not retried', () => {
    expect(shouldRetry({ status: 200 }, 1)).toBe(false)
    expect(shouldRetry({ status: 204 }, 1)).toBe(false)
  })

  test('a server error is retried', () => {
    expect(shouldRetry({ status: 500 }, 1)).toBe(true)
    expect(shouldRetry({ status: 503 }, 3)).toBe(true)
  })

  test('a request that never reached a server is retried', () => {
    expect(shouldRetry({ status: null, error: 'timeout' }, 2)).toBe(true)
  })

  test('a refusal the receiver understood is not retried', () => {
    // Repeating a 404 or a 401 changes nothing.
    expect(shouldRetry({ status: 404 }, 1)).toBe(false)
    expect(shouldRetry({ status: 401 }, 1)).toBe(false)
    expect(shouldRetry({ status: 400 }, 1)).toBe(false)
  })

  test('the two 4xx that mean "later" are retried', () => {
    expect(shouldRetry({ status: 408 }, 1)).toBe(true)
    expect(shouldRetry({ status: 429 }, 1)).toBe(true)
  })

  test('gives up at the attempt limit', () => {
    expect(shouldRetry({ status: 500 }, MAX_ATTEMPTS)).toBe(false)
    expect(shouldRetry({ status: null }, MAX_ATTEMPTS)).toBe(false)
  })
})

describe('shouldDeactivate', () => {
  test('leaves a healthy webhook alone', () => {
    expect(shouldDeactivate({ consecutiveFailures: 0, daysSinceLastSuccess: 0 })).toBe(false)
  })

  test('leaves a webhook that failed a few times alone', () => {
    expect(shouldDeactivate({ consecutiveFailures: 5, daysSinceLastSuccess: 1 })).toBe(false)
  })

  test('switches off an endpoint that has not worked in a week', () => {
    expect(shouldDeactivate({ consecutiveFailures: 40, daysSinceLastSuccess: 8 })).toBe(true)
  })

  test('keeps trying a while longer when it worked recently', () => {
    // A busy day of failures after a success yesterday is an outage, not an
    // abandoned endpoint.
    expect(shouldDeactivate({ consecutiveFailures: 40, daysSinceLastSuccess: 1 })).toBe(false)
  })

  test('a webhook that never succeeded is given more rope, then stopped', () => {
    expect(shouldDeactivate({ consecutiveFailures: 30, daysSinceLastSuccess: null })).toBe(false)
    expect(shouldDeactivate({ consecutiveFailures: 50, daysSinceLastSuccess: null })).toBe(true)
  })
})
