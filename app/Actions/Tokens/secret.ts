/**
 * Making a token, and checking one.
 *
 * The shape is `ros_<id>_<secret>`, and the two halves do different jobs:
 *
 *   id      public, stored in cleartext, indexed. A token found in a log is
 *           identifiable and revocable without anybody guessing which one it
 *           is, and a lookup is one indexed read rather than a scan that hashes
 *           every row in the table.
 *   secret  256 bits from the system CSPRNG, stored only as a SHA-256 hash.
 *
 * SHA-256 rather than bcrypt or argon2 on purpose. Those exist to make guessing
 * a *low entropy* human-chosen password expensive. This secret is 256 random
 * bits, so there is nothing to guess, and a slow hash on every API request would
 * buy no security and cost real latency on the hot path.
 *
 * Pure over its inputs apart from the one function that asks for randomness, so
 * the format and the comparison can be tested directly.
 */

const PREFIX = 'ros'
const ID_BYTES = 8
const SECRET_BYTES = 32

export interface IssuedToken {
  /** The whole thing, shown once and never stored. */
  token: string
  /** The public half, stored in cleartext. */
  prefix: string
  /** What goes in the database. */
  hash: string
}

/** Generate a new token. The only function here that is not deterministic. */
export function generateToken(): IssuedToken {
  const id = randomHex(ID_BYTES)
  const secret = randomHex(SECRET_BYTES)
  const prefix = `${PREFIX}_${id}`
  const token = `${prefix}_${secret}`

  return { token, prefix, hash: hashToken(token) }
}

/** SHA-256 of a token, hex encoded. Deterministic, so it is directly testable. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

/**
 * The public half of a token, or null when it is not one of ours.
 *
 * Called before any database work, so a malformed `Authorization` header costs
 * a string split rather than a query.
 */
export function prefixOf(token: string): string | null {
  const parts = token.split('_')

  if (parts.length !== 3)
    return null

  const [scheme, id, secret] = parts

  if (scheme !== PREFIX)
    return null

  if (!isHex(id, ID_BYTES * 2) || !isHex(secret, SECRET_BYTES * 2))
    return null

  return `${scheme}_${id}`
}

/**
 * Whether a presented token matches a stored hash.
 *
 * Compared in constant time. The prefix has already narrowed this to one row, so
 * a timing signal here would leak the hash of that specific token rather than
 * anything about the table, but a comparison that leaks nothing costs the same
 * as one that does.
 */
export function tokenMatches(presented: string, storedHash: string): boolean {
  return constantTimeEquals(hashToken(presented), storedHash)
}

/**
 * How a token is displayed once it can no longer be shown in full.
 *
 * The prefix plus the shape of what is missing, so somebody comparing a token in
 * a CI settings page against a token in a list can tell whether they match.
 */
export function maskToken(prefix: string): string {
  return `${prefix}_${'.'.repeat(8)}`
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)

  return [...buffer].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isHex(value: string | undefined, length: number): boolean {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}

/**
 * Compare two equal-length hex strings without leaking where they differ.
 *
 * Both sides are hashes here, so the lengths always match; a length difference
 * means something is malformed and is reported without comparing further.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false

  let difference = 0
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)

  return difference === 0
}
