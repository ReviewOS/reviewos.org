/**
 * Deciding whether a pasted SSH key is one this forge will accept.
 *
 * The *format* is `ts-ssh`'s job: reading the line, checking that the type in
 * the text agrees with the type inside the blob, and computing the fingerprint
 * `ssh-keygen -l` prints. That is protocol, it is the same everywhere, and it
 * used to be a hand-written copy here - a second implementation of a format
 * that had to stay right forever, in a file about user accounts.
 *
 * What is left is the part that is genuinely this application's: which key
 * types are allowed, how small an RSA key may be, and what to say to somebody
 * who pasted the wrong thing. Those are policy. Another forge would answer them
 * differently and still be correct.
 *
 * Pure, so the rules can be tested without a database or a running daemon.
 * `AddSshKeyAction` does the database work.
 */

import { parseAuthorizedKey } from '@stacksjs/ts-ssh'

/** Key types accepted for push authentication. */
export const ACCEPTED_KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] as const
export type SshKeyType = typeof ACCEPTED_KEY_TYPES[number]

/**
 * RSA keys below this many bits are refused.
 *
 * 1024-bit RSA is broken in practice and 2048 is the floor every current
 * guideline agrees on. The bit count comes from the encoded modulus rather than
 * from anything the user told us.
 */
export const MIN_RSA_BITS = 2048

export type SshKeyParse
  = | { ok: true, type: SshKeyType, body: string, comment: string, bits: number | null }
    | { ok: false, message: string }

/**
 * Read an `ssh-<type> <base64> [comment]` line, and decide whether to keep it.
 *
 * Rejects rather than repairs: a key that needed guessing to read is a key
 * whose owner should paste it again.
 */
export function parseSshPublicKey(raw: string): SshKeyParse {
  const line = raw.trim().replace(/\s+/g, ' ')

  if (line.length === 0)
    return { ok: false, message: 'Paste a public key.' }

  // Checked before parsing, because a private key pasted by mistake must never
  // be stored and saying so plainly is more useful than a parse error.
  if (line.includes('PRIVATE KEY'))
    return { ok: false, message: 'That is a private key. Paste the matching .pub file instead.' }

  // The type is read off the line before parsing, so a well-formed key of a
  // type this forge does not take is told exactly that. `ts-ssh` refuses an
  // `ssh-dss` line by returning null - correctly, it does not implement it -
  // and a generic parse error would leave somebody re-pasting a key that was
  // never going to be accepted.
  const [type, body] = line.split(' ')

  if (!type || !body)
    return { ok: false, message: 'A public key looks like `ssh-ed25519 AAAA... comment`.' }

  if (!ACCEPTED_KEY_TYPES.includes(type as SshKeyType))
    return { ok: false, message: `Unsupported key type. Use one of: ${ACCEPTED_KEY_TYPES.join(', ')}.` }

  const key = parseAuthorizedKey(line)

  // One message for the rest. The type was acceptable, so what is left is a
  // body that will not decode or one that decodes to a different key than the
  // line claims - and neither is something the person pasting can act on
  // beyond pasting it again.
  if (!key)
    return { ok: false, message: 'The key body does not match its type, or is not valid base64.' }

  const bits = key.type === 'ssh-rsa' ? key.bits ?? null : null

  if (key.type === 'ssh-rsa' && (bits === null || bits < MIN_RSA_BITS))
    return { ok: false, message: `RSA keys must be at least ${MIN_RSA_BITS} bits.` }

  // The body is stored as it was written rather than re-encoded from the blob:
  // it is what the user pasted, and it round trips unchanged.
  return { ok: true, type: key.type as SshKeyType, body, comment: key.comment, bits }
}

/**
 * The OpenSSH fingerprint of a key body.
 *
 * Kept async and keyed on the base64 body, which is the shape every caller
 * already passes and what the column holds. The digest itself is `ts-ssh`'s.
 */
export async function fingerprintOf(body: string): Promise<string> {
  const { fingerprintOf: fingerprint } = await import('@stacksjs/ts-ssh')
  const bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0))

  return fingerprint(bytes)
}
