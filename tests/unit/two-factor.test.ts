// Recovery codes: the part of two-factor that decides whether anybody turns it
// on.
//
// Everybody understands the second factor. What stops them is the thought of
// losing the device, so the recovery path has to be obviously trustworthy -
// which means it has to be readable off a screen, typable by somebody who is
// already flustered, and impossible to reuse.

import { describe, expect, test } from 'bun:test'
import { generateRecoveryCode, hashRecoveryCode, normalizeCode, RECOVERY_CODE_COUNT } from '../../app/Actions/Auth/twoFactor'

describe('the shape of a code', () => {
  test('is two groups of five, hyphenated', () => {
    expect(generateRecoveryCode()).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
  })

  test('leaves out the characters people misread', () => {
    /*
     * No `i`, `l`, `o`, `0` or `1`. These are read aloud off a phone or copied
     * from a printout, and the difference between `l` and `1` in most fonts is
     * a support request - from somebody who is already locked out, which is the
     * worst moment to give them an ambiguous string.
     */
    const sample = Array.from({ length: 400 }, () => generateRecoveryCode()).join('')

    expect(sample).not.toMatch(/[ilo01]/)
  })

  test('does not repeat itself', () => {
    // Fifty bits each. A collision in two hundred would mean the generator is
    // not doing what it says.
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()))

    expect(codes.size).toBe(200)
  })

  test('ten of them, which is the number that feels like enough', () => {
    // Enough that somebody who has spent two does not feel they are running
    // out, few enough to fit on a printed page without scrolling.
    expect(RECOVERY_CODE_COUNT).toBe(10)
  })
})

describe('reading one back', () => {
  test('case, spaces and the hyphen are all optional', () => {
    /*
     * Somebody reading a code off a printed page types it the way it looks to
     * them, which is not necessarily the way it was written. A recovery code
     * refused for a capital letter is a person locked out by punctuation.
     */
    const canonical = normalizeCode('abcde-fghjk')

    expect(normalizeCode('ABCDE-FGHJK')).toBe(canonical)
    expect(normalizeCode('abcde fghjk')).toBe(canonical)
    expect(normalizeCode('abcdefghjk')).toBe(canonical)
    expect(normalizeCode('  AbCdE-FgHjK  ')).toBe(canonical)
  })

  test('two different codes do not normalize to the same thing', () => {
    expect(normalizeCode('abcde-fghjk')).not.toBe(normalizeCode('abcde-fghjm'))
  })
})

describe('what is stored', () => {
  test('is a hash, and never the code', async () => {
    /*
     * A recovery code bypasses the second factor completely, so a database dump
     * containing them is a dump containing a way past two-factor for every
     * account on the instance - which is exactly what two-factor was bought to
     * prevent.
     */
    const code = generateRecoveryCode()
    const hash = await hashRecoveryCode(code)

    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain(normalizeCode(code))
  })

  test('and the hash follows the same normalization the comparison does', async () => {
    // Otherwise a code typed in capitals hashes to something the stored row
    // does not match, and the recovery path fails for exactly the people who
    // need it.
    expect(await hashRecoveryCode('ABCDE-FGHJK')).toBe(await hashRecoveryCode('abcdefghjk'))
  })
})
