import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { decrypt } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'
import { isSecureRequest, sessionCookie, sessionCookieName } from '../Auth/session'
import { dbTimestamp } from '../Support/sql'
import { clientId, redirectUri } from './client'
import { resolveIdentity } from './identity'
import { exchangeCode } from './oauth'

/**
 * The other side of the redirect, where an identity becomes a session.
 *
 * The order here is the security of the whole feature, so it is worth stating:
 * the state finds a row *this server wrote*, the row names the identity the
 * flow was started for, and the token response has to agree with that identity
 * before anything else happens. Only then is a session created or an identity
 * linked.
 *
 * The row is deleted whether or not the exchange succeeds. An authorization
 * code is single-use and so is this: a callback URL sitting in a log, a
 * referrer or somebody's history is a URL that can be replayed, and finding
 * nothing is the correct answer to the second attempt.
 */
export default new Action({
  name: 'AtprotoCallback',
  description: 'Complete an AT Protocol authorization',

  method: 'GET',

  validations: {
    state: { rule: schema.string().max(120) },
    code: { rule: schema.string().max(2000) },
  },

  async handle(request: any) {
    const { response } = await import('@stacksjs/router')

    const state = String(request.get('state') ?? '').trim()
    const code = String(request.get('code') ?? '').trim()
    const refused = String(request.get('error') ?? '').trim()

    if (!state)
      return response.json({ error: 'That authorization did not carry a state.' }, 400)

    const pending = await db
      .selectFrom('atproto_auth_requests')
      .select(['id', 'did', 'handle', 'issuer', 'token_endpoint', 'verifier', 'sealed_key', 'nonce', 'user_id', 'expires_at'])
      .where('state', '=', state)
      .executeTakeFirst()

    // Single-use: consumed before anything can go wrong with it.
    if (pending) {
      await db
        .deleteFrom('atproto_auth_requests')
        .where('id', '=', Number(pending.id))
        .execute()
        .catch(() => undefined)
    }

    if (!pending)
      return response.json({ error: 'That authorization is not one this server started, or it has already been used.' }, 400)

    if (String(pending.expires_at ?? '') < dbTimestamp())
      return response.json({ error: 'That authorization took too long. Start again.' }, 400)

    // The person said no at their own server, which is an answer rather than a
    // failure - and one that must not leave a usable row behind, which it does
    // not, because the row is already gone.
    if (refused)
      return response.json({ error: `The authorization was refused: ${refused}` }, 400)

    if (!code)
      return response.json({ error: 'That authorization did not carry a code.' }, 400)

    let dpop: { privateJwk: JsonWebKey, publicJwk: JsonWebKey }

    try {
      dpop = JSON.parse(String(await decrypt(String(pending.sealed_key))))
    }
    catch {
      return response.json({ error: 'That authorization could not be completed. Start again.' }, 400)
    }

    const exchanged = await exchangeCode({
      server: {
        issuer: String(pending.issuer),
        authorizationEndpoint: '',
        tokenEndpoint: String(pending.token_endpoint),
        parEndpoint: '',
      },
      clientId: clientId(),
      redirectUri: redirectUri(),
      code,
      pkce: { verifier: String(pending.verifier) },
      dpop,
      // The check the flow exists for: the identity this started as.
      expectedDid: String(pending.did),
      nonce: pending.nonce ? String(pending.nonce) : null,
    })

    if ('error' in exchanged)
      return response.json({ error: exchanged.error }, 401)

    /*
     * Resolved again, after the exchange rather than instead of it.
     *
     * The document is what says which PDS an account lives on, and an account
     * that moved between the start of this flow and its end should be recorded
     * where it is now. It is also a second, independent statement that this DID
     * is real - cheap, because it is cached.
     */
    const identity = await resolveIdentity(exchanged.did)
    const now = dbTimestamp()

    const held = await db
      .selectFrom('atproto_identities')
      .select(['id', 'user_id'])
      .where('did', '=', exchanged.did)
      .executeTakeFirst()

    // Linking: somebody was signed in when this began.
    if (pending.user_id) {
      if (held && Number(held.user_id) !== Number(pending.user_id))
        return response.json({ error: 'That identity cannot be linked.' }, 409)

      if (held) {
        await db
          .updateTable('atproto_identities')
          .set({ handle: identity?.handle ?? pending.handle, pds: identity?.pds ?? null, last_verified_at: now, updated_at: now })
          .where('id', '=', Number(held.id))
          .execute()
      }
      else {
        await db
          .insertInto('atproto_identities')
          .values({
            user_id: Number(pending.user_id),
            did: exchanged.did,
            handle: identity?.handle ?? pending.handle,
            pds: identity?.pds ?? null,
            last_verified_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute()
      }

      return response.json({ linked: true, did: exchanged.did, handle: identity?.handle ?? pending.handle })
    }

    /*
     * Signing in, and this is where the registration form disappears.
     *
     * An identity nobody has linked signs in to no account. Creating one here
     * would be an open registration endpoint wearing a protocol as a disguise,
     * on an instance whose operator may have deliberately closed registration -
     * so an unknown identity is told to link it from an account instead. That
     * is the smaller, honest version of the feature, and the box in phase 10
     * says which half is built.
     */
    if (!held) {
      return response.json({
        error: 'That identity is not linked to an account on this instance. Sign in and link it first.',
        did: exchanged.did,
      }, 403)
    }

    await db
      .updateTable('atproto_identities')
      .set({ handle: identity?.handle ?? pending.handle, pds: identity?.pds ?? null, last_verified_at: now, updated_at: now })
      .where('id', '=', Number(held.id))
      .execute()

    const { Auth } = await import('@stacksjs/auth')
    const session: any = await Auth.loginUsingId(Number(held.user_id))

    const headers = new Headers()
    headers.append('Set-Cookie', sessionCookie(await sessionCookieName(), String(session.token), {
      maxAgeSeconds: Number(session.expiresIn ?? 60 * 60 * 24 * 7),
      secure: isSecureRequest(request),
    }))
    headers.set('Content-Type', 'application/json')
    headers.set('Cache-Control', 'no-store')

    return new Response(JSON.stringify({ signed_in: true, did: exchanged.did, handle: identity?.handle ?? pending.handle }), {
      status: 200,
      headers,
    })
  },
})
