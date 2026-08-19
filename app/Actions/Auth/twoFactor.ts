/**
 * The second factor: enrolling in it, and getting past it.
 *
 * TOTP, because it is the one second factor that works on a self-hosted
 * instance with no accounts anywhere else - no vendor, no push service, no
 * phone number, and an authenticator app the person already has. Passkeys are
 * better and are a separate piece of work; this is the one that can be shipped
 * and verified without a browser in the loop.
 *
 * ## Enrolment is two steps, and the second one is not optional
 *
 * `begin` writes a secret and leaves the factor **off**. `enable` turns it on
 * only after a code generated from that secret has been verified. Skipping the
 * verification is the single most common way this feature locks people out:
 * somebody's clock is wrong, or they photographed the QR code and never
 * scanned it, and they find out at the next sign-in with no way back.
 *
 * ## Recovery codes decide whether anybody turns it on
 *
 * Everybody understands the second factor; what stops them is losing the
 * device. So the codes are issued by the same click that enables the factor,
 * shown once, and hashed at rest - a database dump containing usable recovery
 * codes is a dump containing a way past two-factor for every account, which is
 * exactly what it was bought to prevent.
 */

import { verifyTwoFactorCode } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { dbTimestamp } from '../Support/sql'

/**
 * How many codes to issue.
 *
 * Ten, which is the number every implementation lands on for a good reason: it
 * is enough that somebody who has used two does not feel they are running out,
 * and few enough to fit on a printed page or in a password manager without
 * scrolling.
 */
export const RECOVERY_CODE_COUNT = 10

/** Characters a person can read back off a screen without ambiguity. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * A recovery code, in a shape somebody can type.
 *
 * Two groups of five, hyphenated. The alphabet leaves out `i`, `l`, `o`, `0`
 * and `1`, because these are read aloud from a phone or copied off a printout,
 * and the difference between `l` and `1` in most fonts is a support request.
 *
 * Fifty bits of entropy per code, which is far beyond guessable and still short
 * enough to type twice.
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const letters = [...bytes].map(byte => ALPHABET[byte % ALPHABET.length]).join('')

  return `${letters.slice(0, 5)}-${letters.slice(5)}`
}

/** The hash the column stores. Never the code. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeCode(code)))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A code as it is compared, whatever the person typed.
 *
 * Case and spacing are stripped and the hyphen is optional, because somebody
 * reading a code off a printed page types it the way it looks to them. A
 * recovery code refused for a capital letter is a person locked out by
 * punctuation.
 */
export function normalizeCode(code: string): string {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Issue a fresh set, replacing whatever was there.
 *
 * Replacing rather than adding: a set somebody has printed is a set they
 * believe is current, and leaving the old ones live means a code from a
 * printout in a drawer still works after they deliberately regenerated. Every
 * implementation that got this wrong got it wrong in that direction.
 *
 * Returns the plaintext, which is the only time it exists.
 */
export async function issueRecoveryCodes(userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())

  await db.deleteFrom('recovery_codes').where('user_id', '=', userId).execute()

  for (const code of codes) {
    await db.insertInto('recovery_codes').values({
      user_id: userId,
      code_hash: await hashRecoveryCode(code),
      used_at: null,
    }).execute()
  }

  return codes
}

/** How many are left, for the settings page to warn before they run out. */
export async function remainingRecoveryCodes(userId: number): Promise<number> {

  try {
    const rows = await db
      .selectFrom('recovery_codes')
      .select(['id'])
      .where('user_id', '=', userId)
      // `whereNull`, not `where('used_at', 'is', null)` - that spelling is not
      // supported and throws - and not `where('used_at', '=', null)` either,
      // which compiles and matches nothing, because `x = NULL` is never true.
      // The second is the dangerous one: it looks right and answers zero.
      .whereNull('used_at')
      .execute()

    return rows.length
  }
  catch {
    return 0
  }
}

/**
 * Spend a recovery code, if it is one of theirs and unused.
 *
 * Marked used in the same statement that finds it, scoped to the owner and to
 * being unused. Two recoveries racing would otherwise both match the same row
 * and both succeed, which turns one code into as many as somebody can send at
 * once - and a single-use credential that is not single-use is the whole
 * failure of this mechanism.
 */
export async function spendRecoveryCode(userId: number, code: string): Promise<boolean> {
  const hash = await hashRecoveryCode(code)

  try {
    const rows = await db
      .updateTable('recovery_codes')
      .set({ used_at: dbTimestamp() })
      .where('user_id', '=', userId)
      .where('code_hash', '=', hash)
      .whereNull('used_at')
      .returning(['id'])
      .execute()

    return rows.length > 0
  }
  catch {
    return false
  }
}

/**
 * Whether this is a valid second factor for this account, by either route.
 *
 * One function so every caller treats a TOTP code and a recovery code the same
 * way. They are the same thing to the person holding them - the way past the
 * second factor - and a call site that checks one and forgets the other is a
 * call site where the recovery route silently does not work.
 */
export async function verifySecondFactor(
  user: { id: number, two_factor_secret?: string | null },
  code: string,
  passkey?: unknown,
): Promise<{ ok: boolean, usedRecoveryCode?: boolean, usedPasskey?: boolean }> {
  /*
   * A passkey first, when one was offered.
   *
   * It is the strongest of the three and the only one that cannot be phished -
   * the signature is over the origin the browser is actually on, so a
   * convincing copy of this sign-in page on another domain gets a signature
   * that verifies against nothing. Somebody who has one should never be asked
   * for six digits as well.
   */
  if (passkey) {
    const { verifyPasskeyAssertion } = await import('./PasskeyAction')

    if (await verifyPasskeyAssertion(user.id, passkey))
      return { ok: true, usedPasskey: true }

    // Falling through rather than returning: an assertion that failed is not a
    // reason to refuse a correct code from the same person, and a browser that
    // sends a stale assertion alongside a fresh code should not lock them out.
  }

  const offered = String(code ?? '').trim()

  if (!offered)
    return { ok: false }

  const secret = String(user.two_factor_secret ?? '')

  // The six digits first, because it is what almost every attempt is.
  if (secret && /^\d{6}$/.test(offered)) {
    try {
      if (await verifyTwoFactorCode(offered, secret))
        return { ok: true }
    }
    catch {
      // A malformed secret is not a valid code. Falling through to the recovery
      // path is right: somebody whose secret is broken is exactly who needs it.
    }
  }

  if (await spendRecoveryCode(user.id, offered))
    return { ok: true, usedRecoveryCode: true }

  return { ok: false }
}
