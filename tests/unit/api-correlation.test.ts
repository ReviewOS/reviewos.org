// The id that follows a request into the work it starts.
//
// The question it answers is the one support gets: a program called the API
// twenty minutes ago and something odd happened - what did that call do? The
// alternative key is a timestamp, which is the worst possible one on an
// instance where three deploy bots dispatch the same workflow every few
// minutes.

import { describe, expect, test } from 'bun:test'
import { clean, requestIdOf } from '../../app/Api/correlation'

function sending(headers: Record<string, string>) {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  }
}

describe('a caller who sent an id', () => {
  test('keeps it, because the value is entirely on their side', () => {
    // They have already logged it beside their own stack trace. An id this
    // instance invented is one they cannot search for.
    expect(requestIdOf(sending({ 'x-request-id': 'abc-123' }))).toBe('abc-123')
  })

  test('and `X-Correlation-Id` counts, because both are in the wild', () => {
    // A client that has to be told which spelling this instance prefers is a
    // client that will get it wrong.
    expect(requestIdOf(sending({ 'x-correlation-id': 'from-the-gateway' }))).toBe('from-the-gateway')
  })

  test('with `X-Request-Id` winning when they sent both', () => {
    expect(requestIdOf(sending({ 'x-request-id': 'theirs', 'x-correlation-id': 'the-proxy\'s' }))).toBe('theirs')
  })
})

describe('a caller who sent none', () => {
  test('gets one, so the run is still traceable from this side', () => {
    const minted = requestIdOf(sending({}))

    expect(minted).toStartWith('req_')
    expect(minted.length).toBeGreaterThan(10)
  })

  test('and two requests do not share it', () => {
    expect(requestIdOf(sending({}))).not.toBe(requestIdOf(sending({})))
  })

  test('and a request object of a shape nobody expected still gets one', () => {
    // This runs on every dispatch. A correlation id is not worth an exception.
    expect(requestIdOf(null)).toStartWith('req_')
    expect(requestIdOf(undefined)).toStartWith('req_')
    expect(requestIdOf({} as any)).toStartWith('req_')
  })
})

describe('what a caller may not decide', () => {
  test('the shape of a log line, a column, or an environment variable', () => {
    /*
     * The id ends up in all three, on somebody else's machine. A caller who
     * sends a newline should not get to decide how any of them are shaped -
     * and nothing anywhere makes a decision on this value, which is what keeps
     * it from being worth forging.
     */
    expect(clean('a\nb')).toBe('ab')
    expect(clean('  spaced  ')).toBe('spaced')
    expect(clean('x'.repeat(500)).length).toBe(120)
  })

  test('and an id of nothing but whitespace is no id at all', () => {
    expect(requestIdOf(sending({ 'x-request-id': '   ' }))).toStartWith('req_')
  })
})
