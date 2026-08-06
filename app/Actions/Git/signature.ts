/**
 * Reading a signature off a commit, and deciding which keys could have made it.
 *
 * Pure, so everything that decides what a signature *means* can be checked
 * without a keyring, a fixture repository, or gpg installed at all. The half
 * that runs anything lives next door in `verify.ts`.
 *
 * Commit object format, from git's own docs: header lines, then a blank line,
 * then the message. A header value continues onto following lines when they
 * begin with a space, which is how a multi-line PGP block fits in one header -
 * including the blank line inside the armor, which is a line holding a single
 * space rather than an empty one.
 */

/** What is known about a commit's signature. */
export type SignatureStatus
  /** No `gpgsig` header. Most commits. */
  = | 'unsigned'
  /** Signed, and the signature is good, by a key registered to a user here. */
    | 'verified'
  /** Signed by a key nobody here has registered, so there is nothing to check it against. */
    | 'unknown_key'
  /** Signed, and the signature did not check out. */
    | 'invalid'
  /** Signed, and this server could not tell - gpg is missing, or it failed. */
    | 'unavailable'

export interface ParsedCommit {
  /** The armored signature, or null when the commit carries none. */
  signature: string | null
  /** `Name <email>` as recorded, unparsed. */
  author: string | null
  committer: string | null
}

/**
 * Read the signature and the identities off a raw commit object.
 *
 * `git cat-file commit <sha>` is the input. This deliberately does *not*
 * reconstruct the signed payload: git verifies the signature itself, and the
 * payload is the commit object with the `gpgsig` header stripped byte for byte
 * - a single character wrong turns a good signature into a bad one, which
 * accuses somebody of forging a commit they wrote. That is not a computation
 * worth owning when git already does it correctly.
 */
export function parseCommitObject(raw: string): ParsedCommit {
  // The message begins after the first blank line. Everything before it is
  // headers, and a signature is a header however many lines it spans.
  const separator = raw.indexOf('\n\n')
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator)

  const lines = headerBlock.split('\n')
  const signature: string[] = []

  let inSignature = false
  let author: string | null = null
  let committer: string | null = null

  for (const line of lines) {
    // A continuation line: it belongs to whichever header came before it.
    // Note that the blank line inside a PGP block is one of these - a line
    // holding a single space, not an empty line.
    if (line.startsWith(' ')) {
      if (inSignature)
        signature.push(line.slice(1))

      continue
    }

    inSignature = false

    if (line.startsWith('gpgsig ')) {
      inSignature = true
      signature.push(line.slice('gpgsig '.length))
      continue
    }

    if (line.startsWith('author '))
      author = line.slice('author '.length)
    if (line.startsWith('committer '))
      committer = line.slice('committer '.length)
  }

  return {
    signature: signature.length > 0 ? signature.join('\n') : null,
    author,
    committer,
  }
}

/**
 * The email out of a `Name <email> 1700000000 +0000` line.
 *
 * Returns it lower-cased, because that is how it is compared: an address is
 * case-insensitive in the part that matters here, and a key registered as
 * `Ada@Example.com` has to match a commit authored as `ada@example.com`.
 */
export function emailFrom(identity: string | null): string | null {
  if (!identity)
    return null

  const match = identity.match(/<([^>]*)>/)
  const email = match?.[1]?.trim().toLowerCase()

  return email ? email : null
}

/**
 * Which registered keys could possibly have signed this commit.
 *
 * Matched on the author's email rather than on the key id, because the key id
 * is inside the signature and reading it needs gpg. A key that does not claim
 * the address is not a candidate: a good signature by somebody else's key over
 * a commit that says it is Ada's is exactly the case this has to not call
 * verified.
 */
export function candidateKeys<T extends { emails?: unknown, expires_at?: unknown }>(
  keys: readonly T[],
  email: string | null,
  now: Date,
): T[] {
  if (!email)
    return []

  return keys.filter((key) => {
    if (!emailsOf(key.emails).includes(email))
      return false

    // An expired key is not a candidate. It signed things when it was valid,
    // and this does not attempt to decide whether it was valid *then* - that
    // needs the signature's timestamp, which needs gpg, and a commit date is
    // attacker-controlled anyway.
    const expires = key.expires_at ? new Date(String(key.expires_at)) : null
    if (expires && !Number.isNaN(expires.getTime()) && expires <= now)
      return false

    return true
  })
}

/**
 * The addresses on a key row.
 *
 * Stored as a JSON array in a text column, which is a shape that arrives as a
 * string, as an array, or as something unparseable depending on who wrote it.
 * A key whose addresses cannot be read has none rather than throwing: it stops
 * being a candidate, and the commit reads as `unknown_key` rather than the
 * whole page failing.
 */
export function emailsOf(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(entry => String(entry).trim().toLowerCase()).filter(Boolean)

  if (typeof value !== 'string' || value.trim() === '')
    return []

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(entry => String(entry).trim().toLowerCase()).filter(Boolean) : []
  }
  catch {
    // Not JSON. A single address in the column is the obvious other thing it
    // could be, and treating it as one beats treating it as nothing.
    return [value.trim().toLowerCase()]
  }
}

/**
 * The key id gpg reports, normalised.
 *
 * gpg prints the long id, and a key is commonly registered by its short one, so
 * they are compared by the last sixteen characters - the long id - and a
 * shorter registration matches on its own suffix.
 */
export function sameKey(reported: string | null, registered: string | null): boolean {
  const a = String(reported ?? '').trim().toUpperCase().replace(/^0X/, '')
  const b = String(registered ?? '').trim().toUpperCase().replace(/^0X/, '')

  if (!a || !b)
    return false

  return a.endsWith(b) || b.endsWith(a)
}

/**
 * Turn an armored key into the bytes a keyring holds.
 *
 * `gpg --dearmor` does exactly this and nothing more: strip the header and
 * footer lines, drop the CRC line, and base64-decode what is left. Doing it
 * here rather than shelling out is not an optimisation - it is what lets a
 * keyring be built without running gpg first, which matters because gpg is only
 * ever reached through git (see `verify.ts` for why).
 *
 * No cryptography happens here. A key that decodes to nonsense is a key gpg
 * will refuse, which is the correct outcome and not this function's to decide.
 */
export function dearmor(armored: string): Uint8Array | null {
  const text = String(armored ?? '')
  const begin = text.indexOf('-----BEGIN')
  if (begin === -1)
    return null

  const afterBegin = text.indexOf('\n', begin)
  const end = text.indexOf('-----END')
  if (afterBegin === -1 || end === -1 || end < afterBegin)
    return null

  const body = text.slice(afterBegin + 1, end).split('\n')
  const base64: string[] = []
  let pastHeaders = false

  for (const raw of body) {
    const line = raw.trim()

    // Armor headers (`Version: ...`, `Comment: ...`) run until the first blank
    // line. A block with no headers starts at the base64 immediately.
    if (!pastHeaders) {
      if (line === '') {
        pastHeaders = true
        continue
      }
      if (/^[A-Za-z][\w-]*:/.test(line))
        continue

      pastHeaders = true
    }

    // The CRC24 line. gpg checks it; there is nothing useful this can do with a
    // mismatch that refusing the key later does not already do.
    if (line.startsWith('='))
      continue
    if (line === '')
      continue

    base64.push(line)
  }

  if (base64.length === 0)
    return null

  try {
    const binary = atob(base64.join(''))
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index)

    return bytes
  }
  catch {
    return null
  }
}
