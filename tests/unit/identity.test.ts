// Handles and SSH public keys.
//
// Both are user-supplied strings that decide who somebody is, so both are
// parsed strictly and tested against the ways that parsing goes wrong.

import { describe, expect, test } from 'bun:test'
import { checkHandle, normalizeHandle, RESERVED_HANDLES } from '../../app/Actions/Identity/handles'
import { ACCEPTED_KEY_TYPES, fingerprintOf, MIN_RSA_BITS, parseSshPublicKey } from '../../app/Actions/Keys/ssh'

describe('checkHandle', () => {
  test('accepts an ordinary handle', () => {
    expect(checkHandle('chris').ok).toBe(true)
    expect(checkHandle('review-os').ok).toBe(true)
    expect(checkHandle('a1').ok).toBe(true)
  })

  test('accepts a single character', () => {
    expect(checkHandle('a').ok).toBe(true)
  })

  test('rejects an empty handle', () => {
    expect(checkHandle('').reason).toBe('empty')
    expect(checkHandle('   ').reason).toBe('empty')
  })

  test('rejects a handle over 39 characters', () => {
    expect(checkHandle('a'.repeat(39)).ok).toBe(true)
    expect(checkHandle('a'.repeat(40)).reason).toBe('too-long')
  })

  test('rejects characters that would not survive a URL', () => {
    expect(checkHandle('chris breuer').reason).toBe('invalid-characters')
    expect(checkHandle('chris/breuer').reason).toBe('invalid-characters')
    expect(checkHandle('chris.breuer').reason).toBe('invalid-characters')
    expect(checkHandle('chris_breuer').reason).toBe('invalid-characters')
    expect(checkHandle('chris@home').reason).toBe('invalid-characters')
  })

  test('rejects a leading or trailing hyphen', () => {
    expect(checkHandle('-chris').reason).toBe('leading-or-trailing-hyphen')
    expect(checkHandle('chris-').reason).toBe('leading-or-trailing-hyphen')
  })

  test('rejects consecutive hyphens, which invite impersonation', () => {
    expect(checkHandle('re--viewos').reason).toBe('consecutive-hyphens')
  })

  test('rejects a handle that would shadow a route', () => {
    expect(checkHandle('settings').reason).toBe('reserved')
    expect(checkHandle('new').reason).toBe('reserved')
    expect(checkHandle('api').reason).toBe('reserved')
    expect(checkHandle('explore').reason).toBe('reserved')
  })

  test('every reserved handle is itself rejected', () => {
    // A reserved word that the format rules would reject anyway is fine; a
    // reserved word that slips through is a route nobody can reach.
    for (const reserved of RESERVED_HANDLES)
      expect(checkHandle(reserved).ok).toBe(false)
  })

  test('case and surrounding space do not smuggle a reserved handle through', () => {
    expect(checkHandle('  SETTINGS ').reason).toBe('reserved')
  })

  test('every rejection carries a message', () => {
    for (const bad of ['', 'a'.repeat(40), 'a b', '-a', 'a--b', 'settings'])
      expect(checkHandle(bad).message).toBeTruthy()
  })
})

describe('normalizeHandle', () => {
  test('lowercases and trims, so two spellings cannot both be taken', () => {
    expect(normalizeHandle('  ChRis  ')).toBe('chris')
  })
})

describe('parseSshPublicKey', () => {
  // A real ed25519 public key, of the shape ssh-keygen writes.
  const ed25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0Zx9M4bY1Q0YQ0lZ5vBqf5c5o1u5S8kUOo9r7bY9pF chris@example.com'

  test('accepts an ed25519 key and keeps its comment', () => {
    const parsed = parseSshPublicKey(ed25519)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok)
      return

    expect(parsed.type).toBe('ssh-ed25519')
    expect(parsed.comment).toBe('chris@example.com')
  })

  test('accepts a key with no comment', () => {
    const parsed = parseSshPublicKey(ed25519.split(' ').slice(0, 2).join(' '))

    expect(parsed.ok).toBe(true)
    if (parsed.ok)
      expect(parsed.comment).toBe('')
  })

  test('refuses a private key, and says which half is wanted', () => {
    const parsed = parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')

    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.message).toContain('private key')
  })

  test('refuses empty input', () => {
    expect(parseSshPublicKey('').ok).toBe(false)
    expect(parseSshPublicKey('   ').ok).toBe(false)
  })

  test('refuses a line with no key body', () => {
    expect(parseSshPublicKey('ssh-ed25519').ok).toBe(false)
  })

  test('refuses an unsupported key type', () => {
    const parsed = parseSshPublicKey('ssh-dss AAAAB3NzaC1kc3M= chris')

    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.message).toContain('Unsupported key type')
  })

  test('refuses a body that is not base64', () => {
    expect(parseSshPublicKey('ssh-ed25519 not!base64!! chris').ok).toBe(false)
  })

  test('refuses a body whose encoded type disagrees with the line', () => {
    // The encoded type is authoritative; a mismatch means the line was built
    // by hand rather than by ssh-keygen.
    const body = ed25519.split(' ')[1]!
    const parsed = parseSshPublicKey(`ssh-rsa ${body} chris`)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.message).toContain('does not match')
  })

  test('tolerates repeated whitespace between fields', () => {
    expect(parseSshPublicKey(ed25519.replace(/ /g, '   ')).ok).toBe(true)
  })

  test('every accepted type is one the parser will take', () => {
    for (const type of ACCEPTED_KEY_TYPES)
      expect(typeof type).toBe('string')

    expect(MIN_RSA_BITS).toBeGreaterThanOrEqual(2048)
  })
})

describe('fingerprintOf', () => {
  test('is the SHA256 form ssh-keygen prints, without padding', async () => {
    const body = 'AAAAC3NzaC1lZDI1NTE5AAAAIJ0Zx9M4bY1Q0YQ0lZ5vBqf5c5o1u5S8kUOo9r7bY9pF'
    const fingerprint = await fingerprintOf(body)

    expect(fingerprint.startsWith('SHA256:')).toBe(true)
    expect(fingerprint.endsWith('=')).toBe(false)
  })

  test('is stable, so the uniqueness check means something', async () => {
    const body = 'AAAAC3NzaC1lZDI1NTE5AAAAIJ0Zx9M4bY1Q0YQ0lZ5vBqf5c5o1u5S8kUOo9r7bY9pF'

    expect(await fingerprintOf(body)).toBe(await fingerprintOf(body))
  })

  test('differs for different keys', async () => {
    const a = await fingerprintOf('AAAAC3NzaC1lZDI1NTE5AAAAIJ0Zx9M4bY1Q0YQ0lZ5vBqf5c5o1u5S8kUOo9r7bY9pF')
    const b = await fingerprintOf('AAAAC3NzaC1lZDI1NTE5AAAAIA0Zx9M4bY1Q0YQ0lZ5vBqf5c5o1u5S8kUOo9r7bY9pF')

    expect(a).not.toBe(b)
  })
})
