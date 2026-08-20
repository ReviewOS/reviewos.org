import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { encrypt } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'
import { dbTimestamp } from '../Support/sql'
import { clientId, redirectUri } from './client'
import { resolveIdentity } from './identity'
import { createDpopKey, createPkce, discoverAuthorizationServer, pushAuthorizationRequest, randomToken } from './oauth'

/** How long an authorization may sit half-finished. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000

/**
 * Begin signing in - or linking - with an AT Protocol identity.
 *
 * Everything expensive happens here rather than in the callback: the identity
 * is resolved, its authorization server is discovered *from the identity*, and
 * the request is pushed. What comes back is a URL to send somebody to, and a
 * row holding what the callback will need to check them when they return.
 *
 * The row records who was signed in when this started. Null is a sign-in and a
 * user id is a link, and the callback must not confuse them: one creates a
 * session and the other binds an identity to an account that already has one.
 */
export default new Action({
  name: 'AtprotoSignIn',
  description: 'Start an AT Protocol authorization for signing in or linking',

  method: 'POST',

  validations: {
    identifier: { rule: schema.string().required().max(253) },
  },

  async handle(request: any) {
    const { response } = await import('@stacksjs/router')
    const identifier = String(request.get('identifier') ?? '').trim().toLowerCase()

    if (!identifier)
      return response.json({ error: 'Give a handle or a DID.' }, 422)

    const identity = await resolveIdentity(identifier)

    if (!identity || !identity.pds) {
      return response.json({
        error: 'That identity could not be verified. A handle has to name a DID whose document names the handle back.',
      }, 422)
    }

    const server = await discoverAuthorizationServer(identity.pds)

    if (!server)
      return response.json({ error: `${identity.pds} does not offer an authorization server this can use.` }, 422)

    const state = randomToken(24)
    const pkce = await createPkce()
    const dpop = await createDpopKey()

    const pushed = await pushAuthorizationRequest({
      server,
      clientId: clientId(),
      redirectUri: redirectUri(),
      // So the server can skip asking who they are. It is a hint and nothing
      // rests on it: the `sub` check in the callback is what decides.
      loginHint: identity.handle ?? identity.did,
      state,
      pkce,
      dpop,
    })

    if ('error' in pushed)
      return response.json({ error: pushed.error }, 502)

    const { currentUser } = await import('../Identity/lookup')
    const user = await currentUser(request)
    const now = new Date()

    await db
      .insertInto('atproto_auth_requests')
      .values({
        state,
        did: identity.did,
        handle: identity.handle,
        issuer: server.issuer,
        token_endpoint: server.tokenEndpoint,
        verifier: pkce.verifier,
        sealed_key: String(await encrypt(JSON.stringify(dpop))),
        nonce: pushed.nonce,
        user_id: user?.id ? Number(user.id) : null,
        expires_at: dbTimestamp(new Date(now.getTime() + AUTHORIZATION_TTL_MS)),
        created_at: dbTimestamp(now),
        updated_at: dbTimestamp(now),
      })
      .execute()

    // Only these two parameters, which is what PAR is for: the request itself
    // is already at the server, so nothing in this URL can be rewritten into a
    // different one.
    const authorize = new URL(server.authorizationEndpoint)
    authorize.searchParams.set('client_id', clientId())
    authorize.searchParams.set('request_uri', pushed.requestUri)

    return response.json({
      authorize: authorize.toString(),
      did: identity.did,
      handle: identity.handle,
      linking: Boolean(user?.id),
    })
  },
})
