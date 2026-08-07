// Reading a pasted GPG public key.
//
// gpg does the reading, so what is pinned here is the policy around it: which
// keys this forge will keep, and what somebody is told when it will not.
//
// The rule that carries the feature is the address one. A commit is verified
// when the signature is good *and* the key claims the address the commit was
// authored with, so a key with no address on it can never verify anything.
// Storing one produces "Unverified" later with no explanation, which is the
// worst of both.
//
// Behind `REVIEWOS_GPG_TESTS=1` like its siblings: gpg allocates locked,
// unswappable memory, and a process the kernel kills reports nothing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { readGpgKey } from '../../app/Actions/Keys/gpg'

const FIXTURES = 'tests/fixtures/gpg'
const meta = JSON.parse(readFileSync(join(FIXTURES, 'meta.json'), 'utf8'))
const publicKey = readFileSync(join(FIXTURES, 'ada.public.asc'), 'utf8')

const enabled = process.env.REVIEWOS_GPG_TESTS === '1'

if (!enabled)
  console.warn('[keys] gpg cases skipped: set REVIEWOS_GPG_TESTS=1 to run them')

describe('readGpgKey, without needing gpg', () => {
  test('asks for a key rather than failing at one', async () => {
    expect(await readGpgKey('')).toEqual({ ok: false, message: 'Paste a public key.' })
    expect(await readGpgKey('   \n ')).toEqual({ ok: false, message: 'Paste a public key.' })
  })

  test('refuses a private key by name', async () => {
    // The single most likely paste, and a parse error would leave somebody
    // trying again with the same file.
    const result = await readGpgKey('-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('private key')
    expect(result.ok === false && result.message).toContain('--export')
  })

  test('refuses something that is not a key at all', async () => {
    const result = await readGpgKey('hello')

    expect(result.ok).toBe(false)
    // Checked before gpg is started: there is nothing to run it on.
    expect(result.ok === false && result.message).toContain('does not look like')
  })
})

describe('readGpgKey', () => {
  test('reads the fingerprint, key id and addresses', async () => {
    if (!enabled)
      return

    const result = await readGpgKey(publicKey)

    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    // The full fingerprint, because `sameKey` matches by suffix and the longer
    // form is the one that cannot collide.
    expect(result.fingerprint).toBe(meta.keyId)
    expect(result.keyId).toBe(meta.keyId.slice(-16))
    expect(result.emails).toEqual([meta.email])
    expect(result.identities[0]).toContain('Ada Lovelace')
    expect(result.expiresAt).toBeNull()
  })

  test('lower-cases the address, because a commit author is matched against it', async () => {
    if (!enabled)
      return

    const result = await readGpgKey(publicKey)

    expect(result.ok && result.emails.every(address => address === address.toLowerCase())).toBe(true)
  })

  test('refuses armor that does not decode', async () => {
    if (!enabled)
      return

    const result = await readGpgKey('-----BEGIN PGP PUBLIC KEY BLOCK-----\nnot base64!!\n-----END PGP PUBLIC KEY BLOCK-----')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('could not be read')
  })

  test('refuses a paste holding more than one key', async () => {
    if (!enabled)
      return

    // Somebody exporting their whole keyring. Taking the first silently would
    // register a key they did not mean to.
    const result = await readGpgKey(`${publicKey}\n${publicKey}`)

    expect(result.ok).toBe(false)
  })

  test('leaves the operator keyring alone', async () => {
    if (!enabled)
      return

    // `show-only` does not import, but gpg still writes a trustdb wherever it
    // is pointed. Reading a pasted key must never touch a keyring that decides
    // anything, so each call gets a home of its own and removes it after.
    const before = process.env.GNUPGHOME
    await readGpgKey(publicKey)

    expect(process.env.GNUPGHOME).toBe(before)
  })
})
