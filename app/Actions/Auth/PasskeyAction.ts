import { Action } from '@stacksjs/actions'
import { Buffer } from 'node:buffer'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'
import {
  authDataFromAttestation,
  checkCeremony,
  counterIsSane,
  encodePublicKey,
  importCoseKey,
  passkeysFor,
  relyingParty,
  sameBytes,
  signatureVerifies,
} from './passkeys'
import { dbTimestamp } from '../Support/sql'

/**
 * Registering a passkey, listing them, and removing one.
 *
 * Signing in *with* one is in `LoginAction`, beside the TOTP code, because it
 * is the same question at the same moment - "prove it is you" - and a second
 * endpoint for it would be a second place the sign-in rules have to be right.
 *
 * ## Registration is two requests, like TOTP enrolment, and for a stronger reason
 *
 * `options` mints a challenge and stores it; `register` verifies the
 * authenticator's answer to that exact challenge. Here it is not merely good
 * practice - a WebAuthn registration is *meaningless* without a
 * server-generated challenge, because the whole proof is that the authenticator
 * signed something it could not have known in advance.
 *
 * ## Your own, always
 *
 * Every operation acts on the caller. An endpoint that could remove somebody
 * else's passkey would be an endpoint that removes a second factor, which is
 * the one thing a stolen session should never be able to do.
 */
export default new Action({
  name: 'Passkey',
  description: 'Register a passkey, list them, or remove one',
  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['list', 'options', 'register', 'remove']) },
    id: { rule: schema.string() },
    credential: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)

    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const operation = String(request.get('operation') ?? 'list').trim()
    const party = relyingParty()

    if (operation === 'list') {
      const passkeys = await passkeysFor(user.id)

      return response.json({
        passkeys: passkeys.map(one => ({ id: one.id, label: one.label, last_used_at: one.lastUsedAt })),
      })
    }

    if (operation === 'options') {
      const { generateRegistrationOptions } = await import('@stacksjs/auth')
      const existing = await passkeysFor(user.id)

      const options = generateRegistrationOptions({
        rpName: party.name,
        rpID: party.id,
        userID: String(user.id),
        userName: String((user as any).handle ?? user.id),
        userDisplayName: String((user as any).name ?? (user as any).handle ?? user.id),
        // So an authenticator that already holds a passkey for this account says
        // so instead of silently making a second one - a list with two
        // indistinguishable rows from the same laptop is a list nobody can
        // safely remove anything from.
        excludeCredentials: existing.map(one => ({ id: fromBase64url(one.id), type: 'public-key' as const })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      })

      await storeChallenge(user.id, options.challenge, 'registration')

      return response.json({ options: serialize(options) })
    }

    if (operation === 'register') {
      const credential = parseCredential(request.get('credential'))

      if (!credential)
        return response.json({ error: 'That is not a credential this instance can read.' }, 422)

      const challenge = await consumeChallenge(user.id, 'registration')

      if (!challenge)
        return response.json({ error: 'That registration has expired. Start again.' }, 400)

      let attested
      let credentialId: string

      try {
        const responses = (credential as any).response ?? {}
        const authenticatorData = authDataFromAttestation(new Uint8Array(responses.attestationObject))

        attested = checkCeremony({
          clientDataJSON: new Uint8Array(responses.clientDataJSON),
          authenticatorData,
          signature: new Uint8Array(0),
          challenge,
          party,
          type: 'webauthn.create',
        })

        const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(party.id)))

        if (!sameBytes(attested.rpIdHash, rpIdHash))
          throw new Error('the credential was made for a different site')

        if (!attested.credentialId || !attested.coseKey)
          throw new Error('the authenticator sent no credential to register')

        credentialId = Buffer.from(attested.credentialId).toString('base64url')
      }
      catch (error) {
        // The reason is shown. It is read by somebody setting up a domain, and
        // "it did not verify" turns a five-minute fix into an afternoon.
        return response.json({ error: `That passkey could not be registered: ${error instanceof Error ? error.message : error}` }, 422)
      }

      /*
       * A passkey that is *only* usable when its owner was there.
       *
       * `userPresent` is the tap; `userVerified` is the fingerprint or the PIN.
       * A credential registered without presence is one an authenticator could
       * assert silently, which is not a second factor - so it is refused here
       * rather than accepted and quietly counted as one.
       */
      if (!attested.userPresent)
        return response.json({ error: 'That authenticator did not confirm somebody was there.' }, 422)

      // Multi-device is what a synced passkey reports, and it is why the
      // counter check below tolerates a permanent zero.
      const deviceType = attested.signCount === 0 ? 'multiDevice' : 'singleDevice'

      await db.insertInto('passkeys').values({
        id: credentialId,
        user_id: user.id,
        webauthn_user_id: String(user.id),
        cred_public_key: encodePublicKey(attested.coseKey!.buffer.slice(
          attested.coseKey!.byteOffset,
          attested.coseKey!.byteOffset + attested.coseKey!.byteLength,
        ) as ArrayBuffer),
        counter: attested.signCount,
        credential_type: 'public-key',
        device_type: deviceType,
        backup_eligible: deviceType === 'multiDevice',
        backup_status: deviceType === 'multiDevice',
        transports: JSON.stringify((credential as any).transports ?? []),
      }).execute()

      await auditEvent('passkey:registered', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { device_type: deviceType },
      })

      return response.json({ registered: true, id: credentialId })
    }

    if (operation !== 'remove')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    const id = String(request.get('id') ?? '').trim()

    if (!id)
      return response.json({ error: 'Which passkey?' }, 422)

    /*
     * Scoped to the caller, so a passkey id guessed or read from somewhere else
     * removes nothing. This is the one destructive operation here and it takes
     * away a second factor, so the `user_id` on the delete is load-bearing.
     */
    const removed = await db
      .deleteFrom('passkeys')
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .returning(['id'])
      .execute()

    if (removed.length > 0) {
      await auditEvent('passkey:removed', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { passkey: id },
      })
    }

    return response.json({ removed: removed.length > 0 })
  },
})

/**
 * Whether this assertion is a valid second factor for this account.
 *
 * Exported because the sign-in path calls it, and it lives here so there is one
 * place that knows what a passkey has to prove. A second copy in `LoginAction`
 * would be a second place to forget the counter check.
 */
export async function verifyPasskeyAssertion(userId: number, raw: unknown): Promise<boolean> {
  const credential = parseCredential(raw)

  if (!credential) {
    console.error('[passkey] the assertion was not readable JSON')

    return false
  }

  const party = relyingParty()
  const challenge = await consumeChallenge(userId, 'authentication')

  if (!challenge) {
    // A challenge that is not there is the ordinary shape of an expired or
    // already-spent ceremony, and saying so beats a silent refusal.
    console.error(`[passkey] no live authentication challenge for account ${userId}`)

    return false
  }

  const stored = (await passkeysFor(userId)).find(one => one.id === String((credential as any).id))

  if (!stored) {
    console.error(`[passkey] no credential ${String((credential as any).id)} on account ${userId}`)

    return false
  }

  try {
    const responses = (credential as any).response ?? {}
    const authenticatorData = new Uint8Array(responses.authenticatorData)
    const clientDataJSON = new Uint8Array(responses.clientDataJSON)

    const asserted = checkCeremony({
      clientDataJSON,
      authenticatorData,
      signature: new Uint8Array(responses.signature),
      challenge,
      party,
      type: 'webauthn.get',
    })

    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(party.id)))

    if (!sameBytes(asserted.rpIdHash, rpIdHash))
      return false

    // The tap. An assertion an authenticator could produce without its owner
    // being there is not a second factor.
    if (!asserted.userPresent)
      return false

    const key = await importCoseKey(new Uint8Array(stored.publicKey))

    if (!await signatureVerifies(key, authenticatorData, clientDataJSON, new Uint8Array(responses.signature)))
      return false

    const counter = asserted.signCount

    /*
     * A counter that did not advance is a cloned credential - somebody
     * extracted the key and is using a copy while the original still works.
     * Except when it is a synced passkey, which reports zero forever because
     * "how many times has this been used" has no answer across devices.
     */
    if (!counterIsSane(stored.counter, counter))
      return false

    await db
      .updateTable('passkeys')
      .set({ counter, last_used_at: dbTimestamp() })
      .where('id', '=', stored.id)
      .execute()

    return true
  }
  catch (error) {
    // Logged rather than swallowed. A passkey that stops working is reported by
    // its owner as "the button does nothing", and this line is the only thing
    // that turns that into a diagnosis.
    console.error('[passkey] assertion failed:', error)

    return false
  }
}

/**
 * Mint and store a challenge for somebody about to use a passkey.
 *
 * Exported for the sign-in path, which needs one before the browser can be
 * asked for an assertion.
 */
export async function issueAuthenticationChallenge(userId: number): Promise<Record<string, unknown> | null> {
  const passkeys = await passkeysFor(userId)

  if (passkeys.length === 0)
    return null

  const { generateAuthenticationOptions } = await import('@stacksjs/auth')
  const party = relyingParty()

  const options = generateAuthenticationOptions({
    rpID: party.id,
    // Named, so the browser offers the ones this account actually has rather
    // than every passkey on the machine.
    allowCredentials: passkeys.map(one => ({ id: fromBase64url(one.id), type: 'public-key' as const })),
    userVerification: 'preferred',
  })

  await storeChallenge(userId, options.challenge, 'authentication')

  return serialize(options)
}

/** Whether this account holds any passkey at all. */
export async function hasPasskey(userId: number): Promise<boolean> {
  return (await passkeysFor(userId)).length > 0
}

/**
 * Store a challenge, replacing any earlier one of the same purpose.
 *
 * Replacing rather than adding: two live registration challenges means an
 * answer to the older one still verifies, and the point of a challenge is that
 * exactly one answer is expected.
 */
async function storeChallenge(userId: number, challenge: Uint8Array | ArrayBuffer, purpose: string): Promise<void> {
  const bytes = challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge)

  await db.deleteFrom('webauthn_challenges').where('user_id', '=', userId).where('purpose', '=', purpose).execute()

  await db.insertInto('webauthn_challenges').values({
    user_id: userId,
    challenge: Buffer.from(bytes).toString('base64'),
    purpose,
    // Two minutes. A WebAuthn prompt is answered in seconds or abandoned, and a
    // challenge lying around is one more thing that could be replayed.
    // A real `datetime` column on the framework's own table, so it needs the
    // literal both engines take rather than an ISO string.
    expires_at: dbTimestamp(new Date(Date.now() + 120_000)),
  }).execute()
}

/** Take the challenge back, and spend it whether or not verification succeeds. */
async function consumeChallenge(userId: number, purpose: string): Promise<Uint8Array | null> {
  const row = await db
    .selectFrom('webauthn_challenges')
    .select(['id', 'challenge', 'expires_at'])
    .where('user_id', '=', userId)
    .where('purpose', '=', purpose)
    .orderBy('id', 'desc')
    .executeTakeFirst()

  if (!row)
    return null

  /*
   * Deleted before it is checked, deliberately.
   *
   * A challenge is single-use whatever the outcome. Deleting only on success
   * would let somebody retry an assertion against the same challenge as many
   * times as they liked, which is exactly the replay the challenge exists to
   * prevent.
   */
  await db.deleteFrom('webauthn_challenges').where('id', '=', Number(row.id)).execute()

  if (row.expires_at && Date.parse(String(row.expires_at)) < Date.now())
    return null

  return Uint8Array.from(Buffer.from(String(row.challenge), 'base64'))
}

/**
 * A credential as JSON, with its binary fields decoded.
 *
 * The browser hands back `ArrayBuffer`s, which do not survive `JSON.stringify`,
 * so every client encodes them base64url and every server has to decode them
 * again. Doing it in one place means the two verifiers below see the shape they
 * expect rather than a string that silently fails a signature check.
 */
function parseCredential(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw

    if (!parsed || typeof parsed !== 'object')
      return null

    const source = parsed as Record<string, any>
    const responses = source.response ?? {}

    return {
      ...source,
      rawId: fromBase64url(String(source.rawId ?? source.id ?? '')),
      response: Object.fromEntries(Object.entries(responses).map(([key, value]) => [
        key,
        typeof value === 'string' && key !== 'transports' ? fromBase64url(value) : value,
      ])),
    }
  }
  catch {
    return null
  }
}

/** Binary fields back out as base64url, so the options survive JSON. */
function serialize(options: Record<string, any>): Record<string, unknown> {
  const encode = (value: unknown): unknown => {
    if (value instanceof Uint8Array)
      return Buffer.from(value).toString('base64url')

    if (value instanceof ArrayBuffer)
      return Buffer.from(new Uint8Array(value)).toString('base64url')

    if (Array.isArray(value))
      return value.map(encode)

    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encode(inner)]))

    return value
  }

  return encode(options) as Record<string, unknown>
}

function fromBase64url(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
