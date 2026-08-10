/**
 * Passkeys: the second factor that cannot be phished.
 *
 * TOTP stops a leaked password and nothing else. Somebody who is looking at a
 * convincing copy of this instance's sign-in page will type their password
 * *and* their six digits into it, and the person on the other end has ninety
 * seconds to use both. A passkey cannot be handed over that way: the signature
 * is over the origin the browser is actually on, so a copy on another domain
 * gets a signature that verifies against nothing.
 *
 * ## The relying party is the origin, and getting it wrong is subtle
 *
 * `rpId` is a domain and `origin` is a scheme plus a host plus a port, and the
 * browser checks both. An instance served at `forge.example.com` must set
 * `APP_URL` to exactly that: a passkey registered against the wrong `rpId` is
 * invisible to the browser afterwards rather than broken loudly, which reads as
 * "passkeys do not work here" and gets the feature removed.
 *
 * ## The verification is the framework's
 *
 * `@stacksjs/ts-auth` does the CBOR, the COSE key parsing and the signature
 * check, and this file is the application around it: whose passkey it is, what
 * a challenge is good for, and when a counter going backwards matters. Writing
 * a second WebAuthn verifier here would be a second thing to get right.
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'

export interface RelyingParty {
  id: string
  name: string
  origin: string
}

/**
 * What this instance calls itself to an authenticator.
 *
 * From `APP_URL`, because it has to match the address in the browser's bar
 * exactly and there is only one value that can be true. A separate setting
 * would be a second place to be wrong, and being wrong here is invisible.
 */
export function relyingParty(): RelyingParty {
  const url = String(process.env.APP_URL ?? 'http://localhost:3000').trim()

  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`)

    return { id: parsed.hostname, name: 'ReviewOS', origin: parsed.origin }
  }
  catch {
    return { id: 'localhost', name: 'ReviewOS', origin: 'http://localhost:3000' }
  }
}

export interface StoredPasskey {
  id: string
  publicKey: ArrayBuffer
  counter: number
  label: string
  lastUsedAt: string | null
}

/** The passkeys on an account, for the settings page and for a challenge. */
export async function passkeysFor(userId: number): Promise<StoredPasskey[]> {
  const db = (globalThis as any).db

  try {
    const rows: any[] = await db
      .selectFrom('passkeys')
      .select(['id', 'cred_public_key', 'counter', 'device_type', 'transports', 'last_used_at'])
      .where('user_id', '=', userId)
      .execute()

    return rows.map(row => ({
      id: String(row.id),
      publicKey: decodePublicKey(String(row.cred_public_key ?? '')),
      counter: Number(row.counter) || 0,
      label: describePasskey(row),
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    }))
  }
  catch {
    return []
  }
}

/**
 * What to call a passkey in a list somebody has to choose from.
 *
 * "Passkey 3" is useless when the question is *which of these do I still have*.
 * The device type and the transports are what the authenticator told us, and
 * between them they distinguish the phone from the laptop from the security key
 * on the keyring - which is as much as WebAuthn gives us, and enough.
 */
export function describePasskey(row: { device_type?: unknown, transports?: unknown }): string {
  const transports = String(row.transports ?? '').toLowerCase()
  const kind = String(row.device_type ?? '').toLowerCase()

  if (transports.includes('usb') || transports.includes('nfc'))
    return 'A security key'

  if (kind === 'multidevice' || transports.includes('hybrid'))
    return 'A phone or a synced passkey'

  return 'This device'
}

/** The stored public key, back as the bytes the verifier wants. */
function decodePublicKey(stored: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(stored, 'base64'))

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** How the public key goes into the column. Base64 of the raw COSE bytes. */
export function encodePublicKey(key: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(key)).toString('base64')
}

/**
 * Whether a counter going backwards means what it usually means.
 *
 * An authenticator that counts increments on every assertion, so a value at or
 * below the last one is the signature that a credential has been *cloned* -
 * somebody extracted the key and is using a copy while the original still
 * works.
 *
 * The exception is real and common: a synced passkey (iCloud Keychain, a
 * password manager) reports zero forever, because "how many times has this been
 * used" has no answer across devices. Treating that as a clone would reject
 * every modern passkey, so a stored zero and a returned zero are accepted.
 */
export function counterIsSane(stored: number, returned: number): boolean {
  if (stored === 0 && returned === 0)
    return true

  return returned > stored
}

/*
 * ---------------------------------------------------------------------------
 * The verification itself, which is here because the framework's is broken.
 * ---------------------------------------------------------------------------
 *
 * `@stacksjs/ts-auth` implements WebAuthn and two things in it stop any real
 * passkey working:
 *
 * 1. **The challenge comparison can never be true.** It reads
 *    `base64Decode(clientDataJSON.challenge)`, which interprets the challenge
 *    bytes as UTF-8 text, and compares that to `base64Encode(expected)`, which
 *    is a base64 string. For a random 32-byte challenge those are never equal,
 *    so `verifyAuthenticationResponse` returned `{ verified: false }` for every
 *    well-formed assertion. Not "sometimes wrong" - never right.
 * 2. **The public key is imported as SPKI.** An authenticator reports a COSE
 *    key, which `importKey('spki', ...)` throws on; the throw was caught and
 *    reported as a bad signature, so a genuine assertion from a genuine device
 *    read as a forgery.
 *
 * Both are fixed in `~/Code/Libraries/ts-auth` and built there. This app's
 * `node_modules/@stacksjs/*` are published copies rather than links to a local
 * checkout, so the override is what makes passkeys work here today - the same
 * situation `app/Models/Job.ts` documents for the queue's column types.
 */

/** A parsed `authenticatorData`, which is a fixed layout rather than CBOR. */
export interface AuthenticatorData {
  rpIdHash: Uint8Array
  userPresent: boolean
  userVerified: boolean
  signCount: number
  /** Present only on registration, where the flags say so. */
  credentialId: Uint8Array | null
  coseKey: Uint8Array | null
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37)
    throw new Error('authenticator data is too short to be authenticator data')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const flags = bytes[32]!

  const parsed: AuthenticatorData = {
    rpIdHash: bytes.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: view.getUint32(33, false),
    credentialId: null,
    coseKey: null,
  }

  // Bit 6 says attested credential data follows: 16 bytes of AAGUID, a
  // two-byte credential id length, the id, and then the COSE key to the end.
  if ((flags & 0x40) !== 0 && bytes.length > 55) {
    const idLength = view.getUint16(53, false)

    parsed.credentialId = bytes.slice(55, 55 + idLength)
    parsed.coseKey = bytes.slice(55 + idLength)
  }

  return parsed
}

/**
 * The `authData` out of an attestation object.
 *
 * A targeted read rather than a CBOR decoder, and deliberately so: the object
 * is always a three-entry map whose `authData` value is a byte string, and a
 * general decoder here would be several hundred lines of parser doing one
 * lookup. The header bytes for a byte string are unambiguous, so finding the
 * key and reading the length that follows it is exact rather than heuristic.
 */
export function authDataFromAttestation(attestation: Uint8Array): Uint8Array {
  // `authData` as a CBOR text string: 0x68 for eight characters, then the name.
  const needle = [0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61]

  for (let i = 0; i <= attestation.length - needle.length; i++) {
    if (needle.some((byte, offset) => attestation[i + offset] !== byte))
      continue

    const at = i + needle.length
    const marker = attestation[at]!

    // Byte string headers: 0x58 one-byte length, 0x59 two-byte, 0x5A four-byte.
    if (marker === 0x58)
      return attestation.slice(at + 2, at + 2 + attestation[at + 1]!)

    if (marker === 0x59) {
      const length = (attestation[at + 1]! << 8) | attestation[at + 2]!

      return attestation.slice(at + 3, at + 3 + length)
    }

    break
  }

  throw new Error('the attestation object carries no authenticator data')
}

/** A COSE EC2 key as a `CryptoKey`, which is what an authenticator reports. */
export async function importCoseKey(cose: Uint8Array): Promise<CryptoKey> {
  const coordinate = (label: number): Uint8Array => {
    for (let i = 0; i < cose.length - 3; i++) {
      if (cose[i] === label && cose[i + 1] === 0x58 && cose[i + 2] === 0x20)
        return cose.slice(i + 3, i + 35)
    }

    throw new Error('the COSE key is missing a coordinate')
  }

  const encode = (part: Uint8Array): string =>
    Buffer.from(part).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: encode(coordinate(0x21)), y: encode(coordinate(0x22)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

/** Whether two byte strings are equal, without leaking where they differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false

  let difference = 0

  for (let i = 0; i < a.length; i++)
    difference |= a[i]! ^ b[i]!

  return difference === 0
}

export interface CeremonyInput {
  clientDataJSON: Uint8Array
  authenticatorData: Uint8Array
  signature: Uint8Array
  challenge: Uint8Array
  party: RelyingParty
  /** `webauthn.create` for registration, `webauthn.get` for an assertion. */
  type: 'webauthn.create' | 'webauthn.get'
}

/**
 * The checks every ceremony shares, in the order a failure is most likely.
 *
 * Returns the parsed authenticator data so the caller can go on to whatever is
 * specific to its half. Throws with a reason rather than returning false,
 * because these messages are read by somebody wiring up a domain and "it did
 * not verify" turns a five-minute fix into an afternoon.
 */
export function checkCeremony(input: CeremonyInput): AuthenticatorData {
  const clientData = JSON.parse(new TextDecoder().decode(input.clientDataJSON))

  if (String(clientData.type) !== input.type)
    throw new Error(`the client data says ${clientData.type}, and this is a ${input.type}`)

  const offered = Uint8Array.from(
    Buffer.from(String(clientData.challenge ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  )

  // Compared as bytes. The browser writes base64url of the raw challenge, and
  // comparing it as text is what makes the framework's version never match.
  if (!sameBytes(offered, input.challenge))
    throw new Error('the response answers a different challenge')

  /*
   * The origin, and this is the check that makes a passkey unphishable.
   *
   * The browser writes the origin it is actually on, and it is signed over. A
   * convincing copy of this sign-in page on another domain produces a signature
   * carrying *that* domain, and nothing else in WebAuthn would notice.
   */
  if (String(clientData.origin) !== input.party.origin)
    throw new Error(`the response was signed for ${clientData.origin}`)

  return parseAuthenticatorData(input.authenticatorData)
}

/**
 * A WebAuthn ECDSA signature as the two raw coordinates.
 *
 * An authenticator emits **DER**: a sequence of two integers, each with a
 * length byte and possibly a leading zero so the high bit does not read as a
 * negative number. `crypto.subtle.verify` wants the opposite - sixty-four bytes
 * of `r || s`, fixed width, no headers.
 *
 * Handing DER straight to `subtle.verify` returns `false` for a *perfectly
 * valid* signature, which is the worst way for this to be wrong: nothing
 * throws, nothing logs, and every real security key is reported as a forgery.
 * It cost an hour here with a software authenticator that emits DER exactly as
 * hardware does.
 */
export function rawSignature(der: Uint8Array): Uint8Array {
  // Already raw. A conforming authenticator sends DER, but a client library
  // that converted first should not be broken by converting twice.
  if (der.length === 64)
    return der

  if (der[0] !== 0x30)
    throw new Error('the signature is neither DER nor a raw pair')

  const raw = new Uint8Array(64)
  let offset = 2

  for (const half of [0, 32]) {
    if (der[offset] !== 0x02)
      throw new Error('the signature is not two integers')

    const length = der[offset + 1]!
    const start = offset + 2
    const bytes = der.slice(start, start + length)

    // Left-padded to thirty-two, and a leading zero dropped: DER adds one when
    // the top bit is set, and the raw form has no room for it.
    const trimmed = bytes.length > 32 ? bytes.slice(bytes.length - 32) : bytes

    raw.set(trimmed, half + (32 - trimmed.length))
    offset = start + length
  }

  return raw
}

/** Whether the signature is this key's, over what the ceremony signs. */
export async function signatureVerifies(
  key: CryptoKey,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON as unknown as ArrayBuffer))
  const signed = new Uint8Array(authenticatorData.length + clientDataHash.length)

  signed.set(authenticatorData, 0)
  signed.set(clientDataHash, authenticatorData.length)

  return await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    rawSignature(signature) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  )
}
