/**
 * Parsing and fingerprinting SSH public keys.
 *
 * Pure functions over the text a user pastes, so the rules can be tested
 * without a database or a running SSH daemon. `AddSshKeyAction` does the
 * database work; everything about what makes a key acceptable lives here.
 */

/** Key types accepted for push authentication. */
export const ACCEPTED_KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] as const
export type SshKeyType = typeof ACCEPTED_KEY_TYPES[number]

/**
 * RSA keys below this many bits are refused.
 *
 * 1024-bit RSA is broken in practice and 2048 is the floor every current
 * guideline agrees on. The bit count is derived from the encoded modulus rather
 * than trusted from the user.
 */
export const MIN_RSA_BITS = 2048

export type SshKeyParse =
  | { ok: true, type: SshKeyType, body: string, comment: string, bits: number | null }
  | { ok: false, message: string }

/**
 * Parse an `ssh-<type> <base64> [comment]` line.
 *
 * Rejects rather than repairs: a key that needed guessing to read is a key
 * whose owner should paste it again.
 */
export function parseSshPublicKey(raw: string): SshKeyParse {
  const line = raw.trim().replace(/\s+/g, ' ')

  if (line.length === 0)
    return { ok: false, message: 'Paste a public key.' }

  // A private key pasted by mistake must never be stored, and saying so plainly
  // is more useful than a parse error.
  if (line.includes('PRIVATE KEY'))
    return { ok: false, message: 'That is a private key. Paste the matching .pub file instead.' }

  const parts = line.split(' ')
  if (parts.length < 2)
    return { ok: false, message: 'A public key looks like `ssh-ed25519 AAAA... comment`.' }

  const [type, body, ...rest] = parts

  if (!ACCEPTED_KEY_TYPES.includes(type as SshKeyType))
    return { ok: false, message: `Unsupported key type. Use one of: ${ACCEPTED_KEY_TYPES.join(', ')}.` }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body!))
    return { ok: false, message: 'The key body is not valid base64.' }

  let decoded: Uint8Array
  try {
    decoded = Uint8Array.from(atob(body!), char => char.charCodeAt(0))
  }
  catch {
    return { ok: false, message: 'The key body is not valid base64.' }
  }

  // The encoded key repeats its own type in the first field. A mismatch means
  // the line was assembled by hand, and the encoded value is the real one.
  const encodedType = readString(decoded, 0)
  if (!encodedType || encodedType.value !== type)
    return { ok: false, message: 'The key body does not match its type.' }

  const bits = type === 'ssh-rsa' ? rsaBits(decoded, encodedType.next) : null
  if (type === 'ssh-rsa' && (bits === null || bits < MIN_RSA_BITS))
    return { ok: false, message: `RSA keys must be at least ${MIN_RSA_BITS} bits.` }

  return { ok: true, type: type as SshKeyType, body: body!, comment: rest.join(' '), bits }
}

/**
 * The OpenSSH fingerprint: `SHA256:` plus the base64 of the key's SHA-256, with
 * padding stripped, which is what `ssh-keygen -l` prints.
 */
export async function fingerprintOf(body: string): Promise<string> {
  const bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
  return `SHA256:${base64.replace(/=+$/, '')}`
}

/** Read a length-prefixed string from the SSH wire format. */
function readString(bytes: Uint8Array, offset: number): { value: string, next: number } | null {
  if (offset + 4 > bytes.length)
    return null

  const length = (bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
  const start = offset + 4
  const end = start + length

  if (length < 0 || end > bytes.length)
    return null

  return { value: new TextDecoder().decode(bytes.subarray(start, end)), next: end }
}

/**
 * Bit length of an RSA key, from the modulus.
 *
 * The wire format is `string type, mpint e, mpint n`. An mpint carries a
 * leading zero byte when the high bit would otherwise make it negative, so that
 * byte is skipped before counting.
 */
function rsaBits(bytes: Uint8Array, afterType: number): number | null {
  const exponent = readBytes(bytes, afterType)
  if (!exponent)
    return null

  const modulus = readBytes(bytes, exponent.next)
  if (!modulus)
    return null

  let value = modulus.value
  while (value.length > 0 && value[0] === 0)
    value = value.subarray(1)

  if (value.length === 0)
    return null

  const leadingZeroBits = Math.clz32(value[0]!) - 24
  return value.length * 8 - leadingZeroBits
}

function readBytes(bytes: Uint8Array, offset: number): { value: Uint8Array, next: number } | null {
  if (offset + 4 > bytes.length)
    return null

  const length = (bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
  const start = offset + 4
  const end = start + length

  if (length < 0 || end > bytes.length)
    return null

  return { value: bytes.subarray(start, end), next: end }
}
