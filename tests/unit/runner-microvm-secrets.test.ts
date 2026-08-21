// How a secret reaches a step in another machine, and where it must not go.
//
// On the host path a job's secrets live in a process environment and nowhere
// else. Crossing a machine boundary is what makes this a question, because every
// obvious route writes them down: the payload disk is a file on the runner's
// real filesystem, and the kernel command line is world-readable inside the
// guest and lands in a JSON file on the host on the way there.

import { describe, expect, test } from 'bun:test'
import { Masker, deliverableSecrets, secretsFrame } from '../../app/Actions/Runner/microvmSecrets'
import { guestAgent } from '../../app/Actions/Runner/microvmProtocol'

describe('what may cross', () => {
  test('is what the instance gave the job', () => {
    expect(deliverableSecrets({ run: { trusted: true }, secrets: { DEPLOY_KEY: 'k', NPM_TOKEN: 't' } }))
      .toEqual({ DEPLOY_KEY: 'k', NPM_TOKEN: 't' })
  })

  test('and nothing at all for an untrusted run', () => {
    /*
     * The instance already refuses this, and this refuses it again. A second lock
     * on the one door whose failure is unrecoverable: a claim endpoint that
     * regressed would otherwise hand a fork's pull request somebody's deploy key,
     * and no later check would catch it.
     */
    expect(deliverableSecrets({ run: { trusted: false }, secrets: { DEPLOY_KEY: 'k' } })).toEqual({})
  })

  test('and a missing `trusted` is trusted, matching the host path', () => {
    // `isNotFalse` is the reading everywhere else. A runner that treated absence
    // as untrusted would refuse every job the instance did not annotate.
    expect(deliverableSecrets({ secrets: { A: '1' } })).toEqual({ A: '1' })
  })

  test('and a name no shell could export is dropped rather than mangled', () => {
    /*
     * Silently renaming it is worse than not delivering it: the workflow looks
     * for the name it wrote, does not find it, and the failure points at the
     * secrets page rather than at a sanitiser nobody knew ran.
     */
    expect(deliverableSecrets({ secrets: { 'GOOD_1': 'a', 'bad-name': 'b', '2START': 'c' } }))
      .toEqual({ GOOD_1: 'a' })
  })
})

describe('the frame the host writes', () => {
  test('declares its length and encodes the values', () => {
    const frame = secretsFrame('n'.repeat(32), { TOKEN: 'hunter2' })

    expect(frame.startsWith(`\x01RVOS ${'n'.repeat(32)} SECRETS `)).toBe(true)
    expect(frame).toContain(Buffer.from('hunter2').toString('base64'))
    // The plain value never appears on the wire in a form a reader would show.
    expect(frame).not.toContain('hunter2')
  })

  test('so a secret containing a newline cannot end its own record', () => {
    /*
     * The reason for base64 rather than quoting. A value with a newline in it -
     * a private key, most obviously - would otherwise terminate the record and
     * the rest of it would be read as another secret's name.
     */
    const key = '-----BEGIN KEY-----\nline two\n-----END KEY-----'
    const frame = secretsFrame('n'.repeat(32), { SSH_KEY: key })
    const body = frame.split('\n').slice(1).filter(Boolean)

    expect(body).toHaveLength(1)
    expect(Buffer.from(body[0]!.split(' ')[1]!, 'base64').toString('utf8')).toBe(key)
  })

  test('and an empty set is still a well-formed frame', () => {
    // The agent reads one frame either way, so a job with no secrets must not
    // leave it waiting on a console that will never say anything.
    expect(secretsFrame('n'.repeat(32), '' as any || {})).toContain('SECRETS 0')
  })
})

describe('masking the console', () => {
  const secret = 'super-secret-value-1234'

  test('removes a value that arrives in one piece', () => {
    const masker = new Masker({ TOKEN: secret })
    const out = masker.push(`before ${secret} after`) + masker.flush()

    expect(out).not.toContain(secret)
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  test('and one split across two writes, which is the whole reason this exists', () => {
    /*
     * `redactSecrets` says outright that a value split across two writes survives
     * it, because it sees one chunk at a time - and points at the runner as the
     * thing that sees the stream. On this path the supervisor is that thing:
     * console chunks are whatever size the pipe produced, so a secret unlucky
     * enough to straddle a boundary would reach the log in two halves, each
     * individually unrecognisable.
     */
    const masker = new Masker({ TOKEN: secret })
    const half = Math.floor(secret.length / 2)

    const out = masker.push(`start ${secret.slice(0, half)}`)
      + masker.push(`${secret.slice(half)} end`)
      + masker.flush()

    expect(out).not.toContain(secret)
    expect(out).toContain('start')
    expect(out).toContain('end')
  })

  test('and one that straddles the release boundary, in a long stream', () => {
    /*
     * The case that leaked, and the reason the test above was not enough.
     *
     * A short stream never exercises the release path at all - everything sits
     * in the held buffer until `flush()`, which redacts it, so the test passed
     * against a masker that was wrong. With enough output to force releases, a
     * value that *starts* in the released portion and finishes in the held tail
     * is not a match yet: its head went out in the clear and the retained half
     * never matched either, because its head had already left. The secret was
     * emitted, in two pieces, having passed through a masker.
     *
     * The fix is to redact the whole buffer before releasing any of it.
     */
    const masker = new Masker({ TOKEN: secret })
    const filler = 'x'.repeat(500)

    let out = ''

    // Feed it in small pieces, with the secret landing mid-stream, so releases
    // happen repeatedly around it.
    out += masker.push(filler)

    for (const piece of `noise ${secret} noise`.match(/.{1,7}/g) ?? [])
      out += masker.push(piece)

    out += masker.push(filler)
    out += masker.flush()

    expect(out).not.toContain(secret)
    expect(out.length).toBeGreaterThan(1000)
  })

  test('and every byte still comes out, in order', () => {
    // Holding a tail back must delay output, never drop it.
    const masker = new Masker({ TOKEN: 'zzzzzzzzzzzzzzzz' })
    const out = masker.push('one ') + masker.push('two ') + masker.push('three') + masker.flush()

    expect(out).toBe('one two three')
  })

  test('and a job with no secrets pays nothing', () => {
    const masker = new Masker({})

    expect(masker.push('anything at all')).toBe('anything at all')
    expect(masker.flush()).toBe('')
  })
})

describe('the guest side', () => {
  test('turns the console echo off before it reads anything', () => {
    /*
     * A serial console echoes what is written to it straight back out, which on
     * this wire means into the job's log - so leaving it on would print every
     * secret to the one place they must never reach.
     */
    const agent = guestAgent()
    const echo = agent.indexOf('stty -echo')
    const read = agent.indexOf('read_secrets()')

    expect(echo).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(echo)
  })

  test('reads them before the first step runs', () => {
    const agent = guestAgent()

    expect(agent.indexOf('\nread_secrets\n')).toBeLessThan(agent.indexOf('sh "/work/steps/'))
  })

  test('and puts them in the environment rather than on the payload disk', () => {
    /*
     * The disk is the route this design refused: it is a file on the runner's
     * real filesystem whose deletion is best-effort, and this codebase has
     * already watched one survive a failed run.
     */
    const agent = guestAgent()

    expect(agent).toContain('export "$line"')
    expect(agent).not.toContain('/work/secrets')
  })
})
