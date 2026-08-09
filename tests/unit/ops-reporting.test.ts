/**
 * Sending an error somewhere an operator will see it.
 *
 * An error reporter is a machine for taking the contents of your process and
 * posting them to a third party, so the tests that matter are not about
 * delivery. They are about the three ways this hurts somebody:
 *
 * 1. leaking a credential into a stranger's database
 * 2. failing the request it was reporting on
 * 3. becoming the outage, by sending the same error ten thousand times
 *
 * Delivery gets one test. Redaction gets a dozen.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { decideSend, fingerprint, redact, redactContext, report, reportingConfig, resetReporting } from '../../app/Ops/reporting'

beforeEach(() => {
  resetReporting()
})

describe('being off', () => {
  it('is the default', () => {
    /*
     * This is self-hosted software, and software that phones home by default is
     * software people stop trusting. Nothing leaves an instance until somebody
     * configures a destination.
     */
    expect(reportingConfig({})).toBeNull()
  })

  it('and reports nothing when it is', async () => {
    expect(await report({ error: new Error('boom') }, {})).toBe('off')
  })

  it('an address that is not one is off, not half on', () => {
    // Half on would be an instance failing to send to a URL nobody can read in
    // a log line, forever.
    expect(reportingConfig({ ERROR_REPORTING_URL: 'not-a-url' })).toBeNull()
  })
})

describe('redaction', () => {
  it('keeps a token prefix and drops the secret', () => {
    /*
     * The prefix is public and is what identifies which token to revoke, so a
     * report that keeps it is more useful and no less safe. The half after it
     * is the credential.
     */
    const text = redact('failed for ros_ab12cd34_ffffffffffffffffffffffffffffffff')

    expect(text).toContain('ros_ab12cd34')
    expect(text).not.toContain('ffffffffffffffffffffffffffffffff')
  })

  it('drops a bearer', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('drops a password out of a connection string', () => {
    // The single most reliable way a credential reaches a stack trace.
    const text = redact('could not connect to postgres://reviewos:hunter2@db:5432/reviewos')

    expect(text).not.toContain('hunter2')
    // And keeps the part that says which database, which is the useful half.
    expect(text).toContain('db:5432')
  })

  it('drops a named field whatever its shape', () => {
    expect(redact('password=hunter2')).not.toContain('hunter2')
    expect(redact('{"token": "abc123def"}')).not.toContain('abc123def')
    expect(redact('api_key: sk-live-9')).not.toContain('sk-live-9')
  })

  it('drops something long and random in a field nobody named', () => {
    const text = redact(`request failed with ${'Ab3'.repeat(20)}`)

    expect(text).toContain('[redacted]')
  })

  it('but keeps a sha, which is the thing a reader needs', () => {
    /*
     * Aggressive redaction has a cost, and this is where it would bite: a
     * commit sha is forty characters of hex and is the most useful single token
     * in a git-related report.
     */
    const sha = 'a'.repeat(40)

    expect(redact(`merge failed at ${sha}`)).toContain(sha)
  })
})

describe('redacting a context', () => {
  it('trusts the key over the value', () => {
    /*
     * A field *called* password is redacted whatever it holds, because a short
     * password is exactly what the value-shaped rules would let through.
     */
    const context = redactContext({ password: 'a', repository: 'acme/api' })

    expect(context?.password).toBe('[redacted]')
    expect(context?.repository).toBe('acme/api')
  })

  it('reaches into nested objects', () => {
    const context = redactContext({ request: { headers: { authorization: 'Bearer abc' } } })

    expect(JSON.stringify(context)).not.toContain('Bearer abc')
  })

  it('and stops before recursing forever', () => {
    // A context assembled from a live object graph can be deep or cyclic, and
    // an error reporter that hangs while reporting an error is the worst of
    // both.
    const deep: any = {}
    let node = deep
    for (let i = 0; i < 20; i += 1) {
      node.child = {}
      node = node.child
    }

    expect(() => redactContext(deep)).not.toThrow()
  })
})

describe('the same error twice', () => {
  it('is sent once per window', () => {
    /*
     * An error loop sends the same report a thousand times a minute, which
     * fills somebody's quota, costs them money, and buries the one report that
     * mattered.
     */
    const key = 'the-same-error'

    expect(decideSend(key, 60_000, 0).send).toBe(true)
    expect(decideSend(key, 60_000, 1000).send).toBe(false)
    expect(decideSend(key, 60_000, 2000).send).toBe(false)
  })

  it('and the suppressed ones are counted, not lost', () => {
    // A loop should show up as one report saying "and 4,812 more" rather than
    // as silence.
    const key = 'the-same-error'

    decideSend(key, 60_000, 0)
    decideSend(key, 60_000, 1000)
    decideSend(key, 60_000, 2000)

    const next = decideSend(key, 60_000, 61_000)

    expect(next.send).toBe(true)
    expect(next.suppressed).toBe(2)
  })

  it('and a different error is not suppressed by it', () => {
    decideSend('one', 60_000, 0)

    expect(decideSend('two', 60_000, 1).send).toBe(true)
  })
})

describe('what counts as the same error', () => {
  it('ignores the numbers in a message', () => {
    /*
     * `user 4181 not found` and `user 9022 not found` are one error. Treating
     * them as two is the difference between suppressing a loop and suppressing
     * nothing.
     */
    expect(fingerprint({ message: 'user 4181 not found' }))
      .toBe(fingerprint({ message: 'user 9022 not found' }))
  })

  it('and the ids', () => {
    expect(fingerprint({ message: 'no such commit deadbeef1234' }))
      .toBe(fingerprint({ message: 'no such commit cafebabe5678' }))
  })

  it('but not two genuinely different failures', () => {
    expect(fingerprint({ message: 'user not found' }))
      .not.toBe(fingerprint({ message: 'repository not found' }))
  })
})

describe('sending', () => {
  it('posts a redacted report and says it sent', async () => {
    let seen: any = null

    const original = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      seen = JSON.parse(String(init.body))
      return new Response('', { status: 200 })
    }) as any

    try {
      const outcome = await report(
        { error: new Error('connect failed for postgres://u:hunter2@db/x'), context: { password: 'a' } },
        { ERROR_REPORTING_URL: 'https://collector.example/hook' },
      )

      expect(outcome).toBe('sent')
      expect(seen.message).not.toContain('hunter2')
      expect(seen.context.password).toBe('[redacted]')
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('never throws when the collector is unreachable', async () => {
    /*
     * The caller is on a path that has already failed. Making the report a
     * second failure is worse than losing it.
     */
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('no route to host') }) as any

    try {
      expect(await report({ error: new Error('boom') }, { ERROR_REPORTING_URL: 'https://nowhere.invalid/hook' }))
        .toBe('failed')
    }
    finally {
      globalThis.fetch = original
    }
  })
})
