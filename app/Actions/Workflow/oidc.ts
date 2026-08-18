/**
 * Tokens a job can use instead of a stored cloud credential.
 *
 * The deploy problem, and the reason every CI system has grown this: a job that
 * ships to a cloud needs to prove who it is, and the obvious way - a long-lived
 * access key in a secret - is a credential that lives forever, works from
 * anywhere, and is one leaked log away from being somebody else's. A token
 * minted here lasts minutes, names exactly which repository and which ref asked
 * for it, and is verifiable by anybody who can fetch this instance's public key.
 *
 * **The claims are GitHub's names**, deliberately. A cloud trust policy is a
 * document somebody writes once and forgets, and the ones people already have
 * are written against `repository`, `repository_owner`, `ref`, `workflow` and a
 * `sub` of `repo:owner/name:ref:refs/heads/main`. Inventing better names would
 * mean every user rewriting a policy to gain nothing.
 *
 * **A fork gets nothing.** By the threat model an untrusted run receives no
 * credentials, and a token that says "I am acme/api on main" is the strongest
 * credential this instance can issue.
 */

import { db } from '@stacksjs/database'
import { decrypt, encrypt } from '@stacksjs/security'

/** How long a token lives. Minutes, because it exists to be used immediately. */
export const TOKEN_TTL_SECONDS = 15 * 60

/** What a token says. The names are GitHub's, so existing trust policies work. */
export interface JobClaims {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  nbf: number
  jti: string
  repository: string
  repository_owner: string
  repository_visibility: string
  run_id: string
  run_number: string
  run_attempt: string
  workflow: string
  workflow_ref: string
  job_workflow_ref: string
  ref: string
  ref_type: string
  sha: string
  event_name: string
  actor: string
  environment?: string
  runner_environment: string
}

/**
 * The subject, which is what a trust policy usually matches on.
 *
 * `repo:acme/api:ref:refs/heads/main`, and for an environment
 * `repo:acme/api:environment:production` - GitHub's shapes, because a policy
 * written for GitHub should keep working when a repository moves here. An
 * environment is the more specific claim and wins, which is what somebody
 * means by "only the production deploy may assume this role".
 */
export function subjectFor(input: {
  repository: string
  ref: string
  environment?: string | null
  event?: string
}): string {
  if (input.environment)
    return `repo:${input.repository}:environment:${input.environment}`

  if (input.event === 'pull_request')
    return `repo:${input.repository}:pull_request`

  return `repo:${input.repository}:ref:${input.ref}`
}

export interface SigningKey {
  kid: string
  algorithm: string
  publicJwk: any
  privateJwk: any
}

/**
 * The key this instance signs with, made on first use.
 *
 * Generated rather than configured: a key an operator has to create is a
 * feature that stays off, and there is nothing to decide - the algorithm is
 * RS256 because every cloud provider's verifier reads it.
 */
export async function signingKey(purpose = 'oidc'): Promise<SigningKey> {
  const existing: any = await db
    .selectFrom('instance_keys')
    .select(['kid', 'algorithm', 'public_jwk', 'sealed_private'])
    .where('purpose', '=', purpose)
    .whereNull('retired_at')
    .orderBy('id', 'desc')
    .executeTakeFirst()

  if (existing) {
    return {
      kid: String(existing.kid),
      algorithm: String(existing.algorithm ?? 'RS256'),
      publicJwk: JSON.parse(String(existing.public_jwk ?? '{}')),
      privateJwk: JSON.parse(String(await decrypt(String(existing.sealed_private)))),
    }
  }

  return generateKey(purpose)
}

/** Make a key, store it, and answer it. */
export async function generateKey(purpose = 'oidc'): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )

  const publicJwk: any = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk: any = await crypto.subtle.exportKey('jwk', pair.privateKey)

  /*
   * Random rather than a fingerprint of the key: a `kid` derived from the
   * public key tells a reader when the key changed, which is a fact about this
   * instance's operations that nobody needs from a JWKS.
   */
  const kid = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex')

  publicJwk.kid = kid
  publicJwk.use = 'sig'
  publicJwk.alg = 'RS256'

  await db
    .insertInto('instance_keys')
    .values({
      purpose,
      kid,
      algorithm: 'RS256',
      public_jwk: JSON.stringify(publicJwk),
      sealed_private: String(await encrypt(JSON.stringify(privateJwk))),
    } as any)
    .execute()

  return { kid, algorithm: 'RS256', publicJwk, privateJwk }
}

/**
 * Rotate: a new key signs from now, and the old one keeps verifying.
 *
 * Both halves matter. Without the first a rotation is a promise; without the
 * second it is an outage, because every token signed a minute ago becomes
 * unverifiable the moment the key changes.
 */
export async function rotateKey(purpose = 'oidc', now = new Date()): Promise<SigningKey> {
  await db
    .updateTable('instance_keys')
    .set({ retired_at: now.toISOString() } as any)
    .where('purpose', '=', purpose)
    .whereNull('retired_at')
    .execute()

  return generateKey(purpose)
}

/** Every key a verifier should still accept: the current one and the retired ones. */
export async function publicKeys(purpose = 'oidc'): Promise<any[]> {
  const rows: any[] = await db
    .selectFrom('instance_keys')
    .select(['public_jwk'])
    .where('purpose', '=', purpose)
    .orderBy('id', 'desc')
    .execute()

  return rows.map(row => JSON.parse(String(row.public_jwk ?? '{}'))).filter(one => one.kty)
}

/** base64url, which is what JWTs are made of and what nothing built in emits. */
function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)

  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A signed token for one job.
 *
 * The signature is over the header and payload exactly as they are sent, which
 * is the whole of JWS: a verifier recomputes the same two strings, so anything
 * this function does to the payload after signing would be a token nobody can
 * verify.
 */
export async function mintOidcToken(claims: JobClaims): Promise<{ token: string, expiresIn: number, kid: string }> {
  const key = await signingKey()

  const header = { alg: key.algorithm, typ: 'JWT', kid: key.kid }
  const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`

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
    new TextEncoder().encode(signing),
  )

  return {
    token: `${signing}.${base64url(new Uint8Array(signature))}`,
    expiresIn: claims.exp - claims.iat,
    kid: key.kid,
  }
}

/**
 * The claims for one job, from what the run already knows.
 *
 * Every value here is a fact this instance holds rather than anything the job
 * said: a token whose `repository` came from the request would be a token any
 * job could mint for any repository, which is the whole thing this replaces.
 */
export function claimsFor(input: {
  issuer: string
  audience: string
  repository: string
  owner: string
  visibility: string
  runId: number
  runNumber: number
  runAttempt: number
  workflow: string
  workflowPath: string
  ref: string
  sha: string
  event: string
  actor: string
  environment?: string | null
  now?: number
}): JobClaims {
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const ref = input.ref || 'refs/heads/main'

  return {
    iss: input.issuer,
    sub: subjectFor({
      repository: input.repository,
      ref,
      environment: input.environment ?? null,
      event: input.event,
    }),
    aud: input.audience,
    iat: now,
    /*
     * A second of leeway, because a verifier's clock is not this one's and a
     * token that is not valid yet fails in the least helpful way there is: an
     * error that goes away if you try again.
     */
    nbf: now - 1,
    exp: now + TOKEN_TTL_SECONDS,
    jti: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
    repository: input.repository,
    repository_owner: input.owner,
    repository_visibility: input.visibility,
    run_id: String(input.runId),
    run_number: String(input.runNumber),
    run_attempt: String(input.runAttempt),
    workflow: input.workflow,
    workflow_ref: `${input.repository}/${input.workflowPath}@${ref}`,
    job_workflow_ref: `${input.repository}/${input.workflowPath}@${ref}`,
    ref,
    ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    sha: input.sha,
    event_name: input.event,
    actor: input.actor,
    ...(input.environment ? { environment: input.environment } : {}),
    // What kind of machine ran it. Named the way Actions names it, because a
    // policy that refuses self-hosted runners reads this claim.
    runner_environment: 'self-hosted',
  }
}
