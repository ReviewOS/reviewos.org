// Making a token, and checking one.
//
// The properties worth pinning are that the stored form never contains the
// secret, that a malformed header is rejected before any database work, and
// that the prefix is stable enough to identify a leaked token from a log line.

import { describe, expect, test } from 'bun:test'
import { generateToken, hashToken, maskToken, prefixOf, tokenMatches } from '../../app/Actions/Tokens/secret'

describe('generateToken', () => {
  test('the token carries its own prefix', () => {
    const issued = generateToken()

    expect(issued.token.startsWith(`${issued.prefix}_`)).toBe(true)
  })

  test('the prefix is recoverable from the token', () => {
    const issued = generateToken()

    expect(prefixOf(issued.token)).toBe(issued.prefix)
  })

  test('the stored hash does not contain the secret', () => {
    const issued = generateToken()
    const secret = issued.token.slice(issued.prefix.length + 1)

    expect(issued.hash).not.toContain(secret)
    expect(issued.hash).toHaveLength(64)
  })

  test('two tokens do not collide', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token))

    expect(tokens.size).toBe(200)
  })

  test('prefixes are unique too, since a lookup keys on one', () => {
    const prefixes = new Set(Array.from({ length: 200 }, () => generateToken().prefix))

    expect(prefixes.size).toBe(200)
  })
})

describe('hashToken', () => {
  test('is deterministic', () => {
    expect(hashToken('ros_aaaaaaaaaaaaaaaa_bb')).toBe(hashToken('ros_aaaaaaaaaaaaaaaa_bb'))
  })

  test('a known vector, so a change to the algorithm is visible here', () => {
    // SHA-256 of the empty string.
    expect(hashToken('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('one character changes the whole hash', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('prefixOf', () => {
  test('rejects a token that is not ours', () => {
    expect(prefixOf('ghp_aaaaaaaaaaaaaaaaaaaa')).toBeNull()
  })

  test('rejects the wrong number of parts', () => {
    expect(prefixOf('ros_abc')).toBeNull()
    expect(prefixOf('ros_a_b_c')).toBeNull()
  })

  test('rejects a secret of the wrong length', () => {
    // Truncating a real token must not resolve to the same prefix, or a partial
    // copy-paste would reach a row and then fail the hash compare, which is a
    // slower and noisier answer than rejecting it outright.
    const issued = generateToken()

    expect(prefixOf(issued.token.slice(0, -1))).toBeNull()
  })

  test('rejects non-hex characters', () => {
    const issued = generateToken()
    const tampered = `${issued.prefix}_${'z'.repeat(64)}`

    expect(prefixOf(tampered)).toBeNull()
  })

  test('rejects an empty string without throwing', () => {
    expect(prefixOf('')).toBeNull()
  })
})

describe('tokenMatches', () => {
  test('the token that was issued matches its hash', () => {
    const issued = generateToken()

    expect(tokenMatches(issued.token, issued.hash)).toBe(true)
  })

  test('a different token does not', () => {
    const issued = generateToken()
    const other = generateToken()

    expect(tokenMatches(other.token, issued.hash)).toBe(false)
  })

  test('a hash of the wrong length is refused rather than compared', () => {
    const issued = generateToken()

    expect(tokenMatches(issued.token, 'deadbeef')).toBe(false)
  })

  test('the prefix alone is not enough', () => {
    // The half stored in cleartext must not authenticate anything on its own.
    const issued = generateToken()

    expect(tokenMatches(issued.prefix, issued.hash)).toBe(false)
  })
})

describe('maskToken', () => {
  test('shows the prefix and hides the rest', () => {
    expect(maskToken('ros_0123456789abcdef')).toBe('ros_0123456789abcdef_........')
  })
})
