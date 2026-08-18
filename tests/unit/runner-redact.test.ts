// Taking secrets out of a log before it is written down.
//
// The runner masks what it was given; this is the second line, and it exists
// because the first is somebody else's program. A runner that is old, patched
// or hostile is still one this instance accepts logs from.

import { describe, expect, test } from 'bun:test'
import { formsOf, MARKER, MIN_REDACTABLE, redactSecrets } from '../../app/Actions/Runner/redact'

describe('what gets removed', () => {
  test('the value, wherever it appears in the line', () => {
    /*
     * The way a credential reaches a log is never `echo $TOKEN` - it is a curl
     * that failed and printed the request it tried.
     */
    const line = 'curl -H "authorization: Bearer ghp_supersecretvalue" https://api.example.com failed'

    expect(redactSecrets(line, ['ghp_supersecretvalue'])).toBe(
      `curl -H "authorization: Bearer ${MARKER}" https://api.example.com failed`,
    )
  })

  test('and its base64 and percent-encoded forms', () => {
    // Half the ecosystem sends `Authorization: Basic`, and a token in a URL is
    // how a failed request prints one.
    const secret = 'hunter2-hunter2'
    const base64 = Buffer.from(secret, 'utf8').toString('base64')

    expect(redactSecrets(`auth: Basic ${base64}`, [secret])).toContain(MARKER)
    expect(redactSecrets(`https://x/?t=${encodeURIComponent('a b/secret+value')}`, ['a b/secret+value']))
      .toContain(MARKER)
  })

  test('every occurrence, not the first', () => {
    const out = redactSecrets('token=abcdefgh and again abcdefgh', ['abcdefgh'])

    expect(out).toBe(`token=${MARKER} and again ${MARKER}`)
  })
})

describe('what is left alone', () => {
  test('a value too short to be one', () => {
    /*
     * A secret of `1` or `dev` would blank a digit or a word everywhere it
     * appears and turn every log on the instance into a puzzle. A value that
     * short is a placeholder somebody set while testing.
     */
    expect(formsOf('dev')).toEqual([])
    expect(redactSecrets('the dev server is up', ['dev'])).toBe('the dev server is up')
    expect(MIN_REDACTABLE).toBeGreaterThan(3)
  })

  test('and ordinary output when no secret appears in it', () => {
    expect(redactSecrets('compiling 42 files', ['ghp_supersecretvalue'])).toBe('compiling 42 files')
  })
})

describe('overlapping values', () => {
  test('the longer one wins, so no marker is left embedded in the other', () => {
    // A repository secret whose value contains an owner secret is not a
    // contrived case: a connection string holds the password.
    const out = redactSecrets('url=postgres://user:swordfish@host/db', ['swordfish', 'postgres://user:swordfish@host/db'])

    expect(out).toBe(`url=${MARKER}`)
  })
})

describe('the limitation', () => {
  test('a value split across two chunks is not caught here', () => {
    /*
     * Stated rather than hidden. This sees one chunk at a time, and holding the
     * tail of every chunk to check the join would mean buffering a log that is
     * meant to be streamed. The runner's own masking covers this case because
     * it sees the stream - and a redaction feature people believe is total is
     * worse than one whose edge they know.
     */
    const first = redactSecrets('token=ghp_super', ['ghp_supersecret'])
    const second = redactSecrets('secret\n', ['ghp_supersecret'])

    expect(first + second).toContain('ghp_super')
    expect(first + second).not.toContain(MARKER)
  })
})
