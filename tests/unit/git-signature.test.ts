import { describe, expect, it } from 'bun:test'
import { candidateKeys, emailFrom, emailsOf, parseCommitObject, sameKey } from '../../app/Actions/Git/signature'

/**
 * Taking a signature off a commit, and deciding which keys could have made it.
 *
 * The payload reconstruction is the part worth testing hardest: a signature
 * covers the commit object with its `gpgsig` header removed, byte for byte, and
 * a single character wrong turns a good signature into a bad one. That failure
 * accuses somebody of forging a commit they wrote, which is the worst thing
 * this feature can do.
 */

/**
 * A commit object as `git cat-file commit` really prints it, signed.
 *
 * Note the line between the armor header and the base64: it is a line
 * containing **one space**, not an empty line. Every continuation line of a
 * header is prefixed with a space, and the blank line inside a PGP block is a
 * continuation line like any other. Written empty here first, and the payload
 * reconstruction came apart on it - `indexOf('\n\n')` found that line and read
 * the rest of the signature as the commit message. Checked against a commit
 * signed by a real gpg rather than reasoned about.
 */
const SIGNED = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
parent 8603f96a36872fa157e65d0a6aa1b5df91c56d60
author Ada Lovelace <ada@example.com> 1700000000 +0000
committer Ada Lovelace <ada@example.com> 1700000000 +0000
gpgsig -----BEGIN PGP SIGNATURE-----
${' '}
 iQEzBAABCAAdFiEE
 =AbCd
 -----END PGP SIGNATURE-----

Document the rounding rule
`

const UNSIGNED = `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
author Ada Lovelace <ada@example.com> 1700000000 +0000
committer Ada Lovelace <ada@example.com> 1700000000 +0000

Document the rounding rule
`

describe('parseCommitObject', () => {
  it('lifts the signature out, continuation lines and all', () => {
    const parsed = parseCommitObject(SIGNED)

    expect(parsed.signature).toContain('-----BEGIN PGP SIGNATURE-----')
    expect(parsed.signature).toContain('iQEzBAABCAAdFiEE')
    expect(parsed.signature).toContain('-----END PGP SIGNATURE-----')
  })

  /**
   * Deliberately absent: a test that the signed payload is reconstructed. It
   * used to be here, and it passed - but git verifies the signature now, so
   * owning that reconstruction bought nothing and risked everything. It is the
   * one computation in this feature where being slightly wrong accuses
   * somebody of forging a commit they wrote.
   */
  it('finds no signature on an unsigned commit', () => {
    const parsed = parseCommitObject(UNSIGNED)

    expect(parsed.signature).toBeNull()
    expect(parsed.author).toBe('Ada Lovelace <ada@example.com> 1700000000 +0000')
  })

  it('reads the author and committer without interpreting them', () => {
    const parsed = parseCommitObject(SIGNED)

    expect(parsed.author).toBe('Ada Lovelace <ada@example.com> 1700000000 +0000')
    expect(parsed.committer).toBe('Ada Lovelace <ada@example.com> 1700000000 +0000')
  })

  /**
   * A message can contain anything, including a line that looks like a header.
   * Only the block before the first blank line is headers.
   */
  it('does not read a header out of the message body', () => {
    const tricky = `tree abc
author Ada <ada@example.com> 1 +0000

gpgsig this is a message that mentions gpgsig
`
    const parsed = parseCommitObject(tricky)

    expect(parsed.signature).toBeNull()
  })
})

describe('emailFrom', () => {
  it('takes the address out of an identity line', () => {
    expect(emailFrom('Ada Lovelace <ada@example.com> 1700000000 +0000')).toBe('ada@example.com')
  })

  /** A key registered as `Ada@Example.com` has to match a commit that says `ada@example.com`. */
  it('lower-cases it, because that is how it is compared', () => {
    expect(emailFrom('Ada <Ada@Example.COM> 1 +0000')).toBe('ada@example.com')
  })

  it('has an answer for a line with no address in it', () => {
    expect(emailFrom('Ada Lovelace 1700000000 +0000')).toBeNull()
    expect(emailFrom(null)).toBeNull()
    expect(emailFrom('Ada <> 1 +0000')).toBeNull()
  })
})

describe('emailsOf', () => {
  it('reads the JSON array the column holds', () => {
    expect(emailsOf('["Ada@example.com", "ada@work.example"]')).toEqual(['ada@example.com', 'ada@work.example'])
  })

  it('takes an array that arrived already parsed', () => {
    expect(emailsOf(['ada@example.com'])).toEqual(['ada@example.com'])
  })

  /** A key whose addresses cannot be read has none, rather than failing the page. */
  it('does not throw on anything else', () => {
    expect(emailsOf(null)).toEqual([])
    expect(emailsOf('')).toEqual([])
    expect(emailsOf('{not json')).toEqual(['{not json'])
    expect(emailsOf(42)).toEqual([])
  })
})

describe('candidateKeys', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const key = (over: Record<string, unknown> = {}) => ({
    key_id: 'ABCDEF0123456789',
    emails: '["ada@example.com"]',
    expires_at: null,
    ...over,
  })

  it('offers a key that claims the address', () => {
    expect(candidateKeys([key()], 'ada@example.com', now)).toHaveLength(1)
  })

  /**
   * The rule that matters. Anybody can sign a commit claiming to be somebody
   * else; a signature proves the signer, and the signer has to be who the
   * commit says wrote it.
   */
  it('refuses a key that does not claim the address', () => {
    expect(candidateKeys([key()], 'someone@else.example', now)).toEqual([])
  })

  it('refuses an expired key', () => {
    expect(candidateKeys([key({ expires_at: '2025-01-01T00:00:00Z' })], 'ada@example.com', now)).toEqual([])
  })

  it('keeps a key that expires later', () => {
    expect(candidateKeys([key({ expires_at: '2027-01-01T00:00:00Z' })], 'ada@example.com', now)).toHaveLength(1)
  })

  it('has an answer for a commit with no author address', () => {
    expect(candidateKeys([key()], null, now)).toEqual([])
  })

  /** An unreadable expiry is not an expiry. It must not quietly drop the key. */
  it('keeps a key whose expiry cannot be read', () => {
    expect(candidateKeys([key({ expires_at: 'whenever' })], 'ada@example.com', now)).toHaveLength(1)
  })
})

describe('sameKey', () => {
  it('matches a short registration against the long id gpg reports', () => {
    expect(sameKey('4AEE18F83AFDEB23', 'AFDEB23')).toBe(true)
    expect(sameKey('AFDEB23', '4AEE18F83AFDEB23')).toBe(true)
  })

  it('ignores case and an 0x prefix', () => {
    expect(sameKey('0x4aee18f83afdeb23', '4AEE18F83AFDEB23')).toBe(true)
  })

  it('does not match a different key', () => {
    expect(sameKey('4AEE18F83AFDEB23', 'DEADBEEFDEADBEEF')).toBe(false)
  })

  it('never matches on nothing', () => {
    expect(sameKey(null, 'ABC')).toBe(false)
    expect(sameKey('ABC', '')).toBe(false)
    expect(sameKey(null, null)).toBe(false)
  })
})
