// The credential a private mirror uses, and the two ways it must not escape.
//
// A mirror's token is never on its row - `credential_ref` names an environment
// variable or a file. What the row *does* store is the last error, which is
// shown in the interface, and git echoes the remote URL in most of its
// failures. So the ordinary first failure of a private mirror - a 403 from an
// expired token - is exactly the moment a live credential would be written into
// the database and onto a page.

import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { authenticatedUrl, mirrorToken, redact } from '../../app/Actions/Mirror/credentials'

describe('resolving a token', () => {
  test('from the environment, by reference', async () => {
    process.env.MIRROR_TOKEN_ACME = 'ghp_fromenvironment'

    try {
      expect(await mirrorToken('acme')).toBe('ghp_fromenvironment')
      // The reference is normalised, because a handle with a hyphen is ordinary
      // and an environment variable with one is not.
      process.env.MIRROR_TOKEN_ACME_PLATFORM = 'ghp_hyphenated'
      expect(await mirrorToken('acme-platform')).toBe('ghp_hyphenated')
    }
    finally {
      delete process.env.MIRROR_TOKEN_ACME
      delete process.env.MIRROR_TOKEN_ACME_PLATFORM
    }
  })

  test('from a file, which is what a secret manager produces', async () => {
    /*
     * Docker secrets, Kubernetes projected volumes and systemd credentials all
     * write a file. Without this an operator with a secret manager has to write
     * a shell wrapper that exports the variable, which puts the secret back
     * where it was trying not to be.
     */
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const directory = await mkdtemp(join(tmpdir(), 'mirror-secret-'))
    const path = join(directory, 'token')

    // With a trailing newline, because every mechanism that writes one does -
    // and a token carrying it is rejected with a message about authentication
    // rather than about whitespace.
    await writeFile(path, 'ghp_fromafile\n')
    process.env.MIRROR_TOKEN_FILED_FILE = path

    try {
      expect(await mirrorToken('filed')).toBe('ghp_fromafile')
    }
    finally {
      delete process.env.MIRROR_TOKEN_FILED_FILE
      const { rm } = await import('node:fs/promises')
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('and an unreferenced mirror falls back to the instance token', async () => {
    process.env.GITHUB_TOKEN = 'ghp_instance'

    try {
      expect(await mirrorToken('')).toBe('ghp_instance')
      expect(await mirrorToken(null)).toBe('ghp_instance')
    }
    finally {
      delete process.env.GITHUB_TOKEN
    }
  })

  test('a reference naming nothing resolves to nothing', async () => {
    // Rather than to the instance token. A mirror that names its own credential
    // and silently used somebody else's would be using a token with the wrong
    // reach, which is the opposite of why it was given a reference.
    expect(await mirrorToken('nothing-here')).toBeNull()
  })
})

describe('putting it in the URL', () => {
  test('an https remote carries it', () => {
    expect(authenticatedUrl('https://github.com/acme/api.git', 'ghp_abc'))
      .toBe('https://x-access-token:ghp_abc@github.com/acme/api.git')
  })

  test('a public mirror is untouched', () => {
    // The path that already worked, and the one somebody tries first.
    expect(authenticatedUrl('https://github.com/acme/api.git', null))
      .toBe('https://github.com/acme/api.git')
  })

  test('an ssh remote is left alone', () => {
    /*
     * ssh authenticates with a key. Adding a password to it produces a URL git
     * cannot parse, which turns a working mirror into a broken one for the sake
     * of a credential it was never going to use.
     */
    expect(authenticatedUrl('ssh://git@github.com/acme/api.git', 'ghp_abc'))
      .toBe('ssh://git@github.com/acme/api.git')
  })

  test('and a URL that already has credentials keeps them', () => {
    // Somebody who put them there on purpose knows something we do not, and
    // overwriting them breaks a mirror that was working.
    const url = 'https://someone:theirtoken@git.example.com/acme/api.git'

    expect(authenticatedUrl(url, 'ghp_abc')).toBe(url)
  })
})

describe('what gets written down when it fails', () => {
  test('a credential in a quoted URL is removed', () => {
    /*
     * This is the failure that actually happens: a token expires, git reports a
     * 403 and quotes the remote it was talking to, and the message is stored on
     * the mirror row and rendered in the interface.
     */
    const message = "fatal: unable to access 'https://x-access-token:ghp_secret@github.com/acme/api.git/': 403"

    expect(redact(message, 'ghp_secret')).not.toContain('ghp_secret')
    expect(redact(message, 'ghp_secret')).toContain('https://***@github.com/acme/api.git')
  })

  test('and a bare one is too, because git does not always quote the URL', () => {
    expect(redact('remote: token ghp_secret is not authorised', 'ghp_secret')).toBe('remote: token *** is not authorised')
  })

  test('two URLs in one message are both cleaned', () => {
    // Non-greedy, or everything between the first and last would collapse into
    // one redaction and the message would stop being readable.
    const message = 'from https://a:b@one.example to https://c:d@two.example'

    expect(redact(message)).toBe('from https://***@one.example to https://***@two.example')
  })

  test('a short token is not used as a needle', () => {
    /*
     * A four-character secret would match inside ordinary words and turn the
     * error into asterisks. The URL form still catches it, and a token that
     * short is not a token any forge issues.
     */
    expect(redact('the host said no', 'no')).toBe('the host said no')
  })

  test('an ordinary message survives unchanged', () => {
    // Redaction that mangles a readable error trades one problem for another:
    // the operator now cannot tell what went wrong either.
    expect(redact('fatal: repository not found')).toBe('fatal: repository not found')
  })
})
