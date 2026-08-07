/**
 * Reading a pasted GPG public key, and deciding whether to keep it.
 *
 * **gpg reads it, this does not.** The same rule the rest of the signature work
 * follows: OpenPGP is a packet format with decades of variation in it, and a
 * parser written here would be a second implementation that has to stay right
 * forever. The binary is a declared dependency and it already knows.
 *
 * It runs against a throwaway `GNUPGHOME`, always. `--import-options show-only`
 * does not import, but gpg still writes a trustdb wherever it is pointed, and
 * the one thing this must never do is put a key somebody pasted into a keyring
 * that decides anything.
 *
 * What is left here is policy, which another forge would answer differently and
 * still be correct: a key with no address on it is refused, because the address
 * is what ties a signature to a commit's author; an expired or revoked key is
 * refused, because storing one only produces "Unverified" later with no
 * explanation; and a private key is refused loudly, because somebody who pasted
 * one needs telling rather than a parse error.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { dependencyPath } from '../Git/git'

export interface GpgKeyDetails {
  /** The full fingerprint. Stored as `key_id`, because `sameKey` matches by suffix. */
  fingerprint: string
  /** The long key id, for showing a person something they will recognise. */
  keyId: string
  /** Every address the key claims, lower-cased. */
  emails: string[]
  /** The identities as gpg prints them, for the interface. */
  identities: string[]
  /** ISO date, or null for a key that does not expire. */
  expiresAt: string | null
}

export type GpgKeyParse
  = | ({ ok: true } & GpgKeyDetails)
    | { ok: false, message: string }

/** How long gpg gets. Reading a key is instant; a hang would hold a request open. */
const TIMEOUT_MS = 10_000

/**
 * Read an armored public key.
 *
 * Returns a message rather than throwing: this is somebody pasting into a form,
 * and every way it can go wrong is a sentence they need to read.
 */
export async function readGpgKey(raw: string): Promise<GpgKeyParse> {
  const armored = raw.trim()

  if (armored.length === 0)
    return { ok: false, message: 'Paste a public key.' }

  // Checked before gpg sees it. A private key must never be stored, and saying
  // so plainly is more useful than whatever gpg would say about it.
  if (armored.includes('PRIVATE KEY BLOCK'))
    return { ok: false, message: 'That is a private key. Export the public one instead: gpg --armor --export <key id>' }

  if (!armored.includes('BEGIN PGP PUBLIC KEY BLOCK'))
    return { ok: false, message: 'That does not look like a GPG public key. Export one with: gpg --armor --export <key id>' }

  const output = await runGpg(armored)
  if (!output.ok)
    return { ok: false, message: output.message }

  const parsed = parseColons(output.stdout)
  if (!parsed)
    return { ok: false, message: 'That key could not be read.' }

  if (parsed.validity === 'r')
    return { ok: false, message: 'That key has been revoked.' }

  if (parsed.validity === 'e' || (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()))
    return { ok: false, message: 'That key has expired. Extend it or export a current one.' }

  if (parsed.emails.length === 0) {
    return {
      ok: false,
      message: 'That key carries no email address. A signature is matched to the address on the commit, so a key without one can never verify anything.',
    }
  }

  return {
    ok: true,
    fingerprint: parsed.fingerprint,
    keyId: parsed.keyId,
    emails: parsed.emails,
    identities: parsed.identities,
    expiresAt: parsed.expiresAt,
  }
}

/** Run gpg over the pasted text, in a keyring that exists for one call. */
async function runGpg(armored: string): Promise<{ ok: true, stdout: string } | { ok: false, message: string }> {
  let home = ''

  try {
    home = await mkdtemp(join(tmpdir(), 'reviewos-gpg-read-'))

    const bin = dependencyPath()
    const result = await new Promise<{ code: number, stdout: string, stderr: string }>((resolvePromise) => {
      const child = spawn('gpg', ['--batch', '--with-colons', '--import-options', 'show-only', '--import'], {
        env: {
          ...process.env,
          ...(bin ? { PATH: `${process.env.PATH ?? ''}:${bin}` } : {}),
          GNUPGHOME: home,
          // gpg's prose is localised and reworded between versions. Only the
          // colon output is parsed, but a log that can be read is worth having.
          LC_ALL: 'C',
        },
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          resolvePromise({ code: -1, stdout, stderr: 'gpg timed out' })
        }
      }, TIMEOUT_MS)

      child.stdout.on('data', chunk => stdout += chunk)
      child.stderr.on('data', chunk => stderr += chunk)

      child.on('error', (error) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: -1, stdout, stderr: String(error) })
      })

      child.on('close', (code) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: code ?? -1, stdout, stderr })
      })

      child.stdin.write(armored)
      child.stdin.end()
    })

    // A key gpg cannot read produces no `pub:` line, whatever the exit code.
    if (!result.stdout.includes('pub:')) {
      return {
        ok: false,
        message: result.stderr.includes('ENOENT') || result.stderr.includes('no such file')
          ? 'This server cannot read GPG keys: gpg is not installed.'
          : 'That key could not be read. Export it with: gpg --armor --export <key id>',
      }
    }

    return { ok: true, stdout: result.stdout }
  }
  catch {
    return { ok: false, message: 'This server could not read that key.' }
  }
  finally {
    if (home)
      await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

interface ParsedKey {
  fingerprint: string
  keyId: string
  emails: string[]
  identities: string[]
  expiresAt: string | null
  validity: string
}

/**
 * Read gpg's colon output.
 *
 * Documented in gpg's `DETAILS`, stable across versions, and the reason
 * `--with-colons` exists: the human output is localised and reformatted between
 * releases, and parsing it is how a key stops importing after an upgrade.
 *
 * Only the first `pub` block is read. A file holding several keys is somebody
 * exporting their whole keyring, and taking the first silently would register a
 * key they did not mean to.
 */
function parseColons(output: string): ParsedKey | null {
  const lines = output.split('\n')
  const pub = lines.find(line => line.startsWith('pub:'))
  if (!pub)
    return null

  if (lines.filter(line => line.startsWith('pub:')).length > 1)
    return null

  const fields = pub.split(':')
  const validity = fields[1] ?? ''
  const keyId = (fields[4] ?? '').toUpperCase()
  const expires = fields[6] ?? ''

  const fingerprint = (lines.find(line => line.startsWith('fpr:'))?.split(':')[9] ?? '').toUpperCase()
  if (!fingerprint && !keyId)
    return null

  const identities: string[] = []
  const emails: string[] = []

  for (const line of lines) {
    if (!line.startsWith('uid:'))
      continue

    // A revoked or expired identity is not one this key still claims.
    const uidValidity = line.split(':')[1] ?? ''
    if (uidValidity === 'r' || uidValidity === 'e')
      continue

    const identity = unescapeColons(line.split(':')[9] ?? '')
    if (!identity)
      continue

    identities.push(identity)

    const address = /<([^>]+)>/.exec(identity)?.[1]?.trim().toLowerCase()
    if (address && !emails.includes(address))
      emails.push(address)
  }

  return {
    fingerprint: fingerprint || keyId,
    keyId: keyId || fingerprint.slice(-16),
    emails,
    identities,
    // Seconds since the epoch, and empty for a key that does not expire.
    expiresAt: /^\d+$/.test(expires) ? new Date(Number(expires) * 1000).toISOString() : null,
    validity,
  }
}

/**
 * gpg escapes a colon in a user id as `\x3a`, and a backslash as `\x5c`.
 *
 * Left unescaped, a name containing a colon shifts every field after it and the
 * address is read out of the wrong one.
 */
function unescapeColons(value: string): string {
  return value.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}
