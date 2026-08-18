/**
 * Signing the work before it leaves the control plane.
 *
 * The threat this answers, in one sentence from the roadmap: **anyone who can
 * write to the control plane's database can execute arbitrary code on every
 * runner in the fleet.** A row in `workflow_version_steps` is a command a
 * machine will run as whoever started the runner, and nothing about the claim
 * protocol distinguishes a step a workflow author wrote from one somebody
 * inserted.
 *
 * A signature closes that gap only if the key is not also in the database, and
 * it is not: the private half is encrypted with `APP_KEY`, which lives in the
 * environment. So a writer who has the database and not the process cannot mint
 * a signature, and a runner that verifies will not run their step.
 *
 * **What is signed is what is executed.** The commands, the environment they
 * run with, the matrix values that vary them, and the working directory - every
 * input that changes what the machine does. Signing the command alone would
 * leave the environment as the way in, which is the same hole one indirection
 * further along.
 */

import { db } from '@stacksjs/database'
import { decrypt } from '@stacksjs/security'
import { generateKey, signingKey } from './oidc'

/** What a signature covers, in the order it is written down. */
export interface SignedWork {
  runId: number
  jobId: number
  /** The steps as the runner will execute them. */
  steps: Array<{ run?: string | null, uses?: string | null, env?: Record<string, string> | null, workingDirectory?: string | null }>
  /** The matrix combination this job is, which changes what the steps mean. */
  matrix: Record<string, unknown> | null
}

export interface StepSignature {
  kid: string
  alg: string
  value: string
}

/**
 * The bytes a signature is over.
 *
 * Canonical, because a signature over "whatever `JSON.stringify` produced this
 * time" is one that fails when a key order changes and passes when it should
 * not. Keys sorted, nothing omitted, no whitespace - the same input on both
 * sides or the check is theatre.
 */
export function canonicalWork(work: SignedWork): string {
  const steps = work.steps.map(step => ({
    env: sorted(step.env ?? {}),
    run: step.run ?? null,
    uses: step.uses ?? null,
    workingDirectory: step.workingDirectory ?? null,
  }))

  return JSON.stringify({
    jobId: Number(work.jobId),
    matrix: work.matrix ? sorted(work.matrix) : null,
    runId: Number(work.runId),
    steps,
  })
}

/** An object with its keys in a fixed order, so two encodings cannot differ. */
function sorted(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}

/** base64, which is what a signature travels as. */
function encode(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * The key that signs dispatched work, made on first use.
 *
 * The JWKs are `JsonWebKey`, the type WebCrypto itself takes: a key read back
 * from the database is a value this instance wrote, and it is handed straight
 * to `importKey`, which is where a wrong shape is caught.
 */
async function stepKey(): Promise<{ kid: string, privateJwk: JsonWebKey, publicJwk: JsonWebKey }> {
  const existing = await db
    .selectFrom('instance_keys')
    .select(['kid', 'public_jwk', 'sealed_private'])
    .where('purpose', '=', 'steps')
    .whereNull('retired_at')
    .orderBy('id', 'desc')
    .executeTakeFirst()

  if (existing) {
    return {
      kid: String(existing.kid),
      publicJwk: JSON.parse(String(existing.public_jwk ?? '{}')) as JsonWebKey,
      privateJwk: JSON.parse(String(await decrypt(String(existing.sealed_private)))) as JsonWebKey,
    }
  }

  /*
   * A separate key from the identity one, and separate because the two say
   * different things: the identity key vouches for *who a job is* to somebody
   * outside, and this one vouches for *what a runner should execute* to a
   * machine inside the fleet. One key doing both means a verifier that accepts
   * either statement in place of the other.
   */
  const made = await generateKey('steps')

  return { kid: made.kid, publicJwk: made.publicJwk, privateJwk: made.privateJwk }
}

/** Sign one job's work. */
export async function signWork(work: SignedWork): Promise<StepSignature | null> {
  try {
    const key = await stepKey()

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      key.privateJwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(canonicalWork(work)),
    )

    return { kid: key.kid, alg: 'RS256', value: encode(signature) }
  }
  catch {
    /*
     * No signature rather than no work. An instance whose key cannot be read -
     * a rotated `APP_KEY`, a database it cannot reach - still hands out jobs,
     * and a pool that *requires* signatures refuses them at the runner. Failing
     * the claim here would take the fleet down over a feature most instances do
     * not enforce.
     */
    return null
  }
}

/**
 * Check a signature against the work, with a key fetched from the instance.
 *
 * Run on the machine, before the first step. `keys` is what the JWKS answered,
 * so a runner verifies against a published key rather than against anything the
 * claim told it - a signature checked with a key from the same message is not a
 * check.
 */
export async function verifyWork(input: {
  work: SignedWork
  signature: StepSignature | null | undefined
  /** The published key set, as `/.well-known/reviewos-step-keys.json` answers it. */
  keys: readonly JsonWebKey[]
}): Promise<{ ok: boolean, reason: string }> {
  if (!input.signature?.value)
    return { ok: false, reason: 'this job arrived without a signature' }

  const jwk = input.keys.find(one => String((one as { kid?: unknown }).kid) === String(input.signature?.kid))

  if (!jwk)
    return { ok: false, reason: `no published key with id ${input.signature.kid}` }

  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Buffer.from(input.signature.value, 'base64'),
      new TextEncoder().encode(canonicalWork(input.work)),
    )

    return valid
      ? { ok: true, reason: 'signed by this instance' }
      : { ok: false, reason: 'the signature does not match the work in this job' }
  }
  catch (error) {
    return { ok: false, reason: `the signature could not be checked: ${error instanceof Error ? error.message : String(error)}` }
  }
}
