/**
 * OpenID Connect: the protocol half.
 *
 * OIDC rather than SAML, because it covers the same identity providers with a
 * fraction of the surface - JSON and a signed token against XML, XML
 * canonicalisation, and signature wrapping attacks that have broken every
 * generation of SAML library.
 *
 * ## Written here rather than on `@stacksjs/socials`
 *
 * That package is OAuth2: get a token, call a provider-specific endpoint, read
 * a profile. OIDC's entire point is the opposite - the identity arrives *in* a
 * token you verify yourself, and the verification is the security property. A
 * client built on a "fetch the profile" abstraction would end up trusting the
 * token endpoint's response without checking the signature, which is the one
 * mistake that makes single sign-on worse than a password.
 *
 * ## What is verified, and why each one
 *
 * - **The signature**, against a key fetched from the provider's JWKS and
 *   matched by `kid`. Without this the `id_token` is a JSON object anybody can
 *   write.
 * - **`iss`**, exactly equal to the configured issuer. A token from a different
 *   provider is a token from a different provider, however well signed.
 * - **`aud`**, containing our client id. A token minted for a *different
 *   application at the same provider* is otherwise accepted here - that is the
 *   confused-deputy attack, and it is the one people miss.
 * - **`exp`**, with a small clock skew. Servers disagree by seconds.
 * - **`nonce`**, matching the one we sent. This is what stops a token captured
 *   from another sign-in being replayed into ours.
 *
 * No dependency: `crypto.subtle` verifies RS256 natively given the JWK.
 */

import { Buffer } from 'node:buffer'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Extra scopes beyond `openid email profile`, e.g. `groups`. */
  scopes: string[]
}

export interface OidcEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

export interface OidcClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  groups?: string[]
}

/** Seconds of clock disagreement tolerated on `exp`. Servers drift. */
const CLOCK_SKEW = 60

/**
 * The provider's endpoints, from its discovery document.
 *
 * Cached in memory for an hour. Not longer: a provider rotating an endpoint is
 * rare but a provider rotating *keys* is routine, and the JWKS URI is read from
 * here. Not shorter: this is on the sign-in path, and a fetch per sign-in makes
 * every login wait on somebody else's server.
 */
const discovered = new Map<string, { at: number, endpoints: OidcEndpoints }>()

const DISCOVERY_TTL_MS = 60 * 60 * 1000

export async function discover(issuer: string, now = Date.now()): Promise<OidcEndpoints> {
  const cached = discovered.get(issuer)

  if (cached && now - cached.at < DISCOVERY_TTL_MS)
    return cached.endpoints

  // The well-known path is appended, not joined - `new URL('.well-known', iss)`
  // discards a path component on an issuer like `https://host/realms/main`,
  // which is exactly how Keycloak issuers look.
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const answer = await fetch(url, { headers: { Accept: 'application/json' } })

  if (!answer.ok)
    throw new Error(`the provider's discovery document answered ${answer.status}`)

  const document: any = await answer.json()

  /*
   * The issuer in the document must be the issuer we asked about.
   *
   * A discovery document is fetched over TLS from a host we chose, so this
   * looks redundant - and it is the check that catches a misconfigured
   * multi-tenant provider handing back another tenant's endpoints, which is a
   * real failure mode and one that would otherwise authenticate people against
   * the wrong directory.
   */
  if (String(document?.issuer ?? '') !== issuer.replace(/\/$/, ''))
    throw new Error('the discovery document names a different issuer')

  const endpoints: OidcEndpoints = {
    issuer: String(document.issuer),
    authorization_endpoint: String(document.authorization_endpoint ?? ''),
    token_endpoint: String(document.token_endpoint ?? ''),
    jwks_uri: String(document.jwks_uri ?? ''),
  }

  if (!endpoints.authorization_endpoint || !endpoints.token_endpoint || !endpoints.jwks_uri)
    throw new Error('the discovery document is missing an endpoint')

  discovered.set(issuer, { at: now, endpoints })

  return endpoints
}

/** Forget everything discovered. For tests, and for a provider that moved. */
export function forgetDiscovery(): void {
  discovered.clear()
}

/** Base64url, which is what every value in this protocol is encoded with. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

export interface AuthorizationStart {
  url: string
  state: string
  nonce: string
  codeVerifier: string
}

/**
 * Where to send the browser, and the three secrets to remember.
 *
 * **PKCE is used even though this is a confidential client with a secret.** The
 * cost is one hash and it closes code interception at the redirect - a
 * malicious application registered for the same custom scheme, a proxy, a
 * browser extension. "We have a client secret" is the reasoning behind most
 * omissions of PKCE and it does not cover the redirect leg at all.
 */
export async function startAuthorization(config: OidcConfig, endpoints: OidcEndpoints): Promise<AuthorizationStart> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)))

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const challenge = base64url(new Uint8Array(digest))

  const url = new URL(endpoints.authorization_endpoint)

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('scope', ['openid', 'email', 'profile', ...config.scopes].join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return { url: url.toString(), state, nonce, codeVerifier }
}

/** Trade the code for tokens. Returns the raw `id_token`, still unverified. */
export async function exchangeCode(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  code: string,
  codeVerifier: string,
): Promise<{ idToken: string, accessToken: string | null }> {
  const answer = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: codeVerifier,
    }).toString(),
  })

  if (!answer.ok)
    throw new Error(`the token endpoint answered ${answer.status}`)

  const body: any = await answer.json()
  const idToken = String(body?.id_token ?? '')

  if (!idToken)
    throw new Error('the token endpoint returned no id_token')

  return { idToken, accessToken: body?.access_token ? String(body.access_token) : null }
}

/**
 * The signing keys, fetched fresh when a `kid` is not among the ones we hold.
 *
 * Cached, but the cache never decides that an unknown key is invalid: a
 * provider rotating keys publishes the new one and starts signing with it
 * immediately, and a client that trusts its cache rejects every sign-in until
 * the cache expires. So a miss refetches once, and only then fails.
 */
const jwksCache = new Map<string, { at: number, keys: any[] }>()

async function keyFor(jwksUri: string, kid: string, now = Date.now()): Promise<any | null> {
  const cached = jwksCache.get(jwksUri)
  const found = cached?.keys.find(key => String(key.kid) === kid)

  if (found)
    return found

  // Either nothing cached or the key is new. One refetch, at most once a
  // minute, so an unknown `kid` cannot be used to make us hammer the provider.
  if (cached && now - cached.at < 60_000)
    return null

  const answer = await fetch(jwksUri, { headers: { Accept: 'application/json' } })

  if (!answer.ok)
    throw new Error(`the provider's key set answered ${answer.status}`)

  const body: any = await answer.json()
  const keys: any[] = Array.isArray(body?.keys) ? body.keys : []

  jwksCache.set(jwksUri, { at: now, keys })

  return keys.find(key => String(key.kid) === kid) ?? null
}

/** Forget the cached keys. For tests, and for a provider that rotated early. */
export function forgetKeys(): void {
  jwksCache.clear()
}

/**
 * Verify an `id_token` and return its claims.
 *
 * Throws on anything it cannot prove, and the message says which check failed -
 * these are read by an operator wiring up a provider, and "invalid token" turns
 * a five-minute configuration fix into an afternoon.
 */
export async function verifyIdToken(
  idToken: string,
  config: OidcConfig,
  endpoints: OidcEndpoints,
  expectedNonce: string,
  now = Date.now(),
): Promise<OidcClaims> {
  const parts = idToken.split('.')

  if (parts.length !== 3)
    throw new Error('the id_token is not a JWT')

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
  const header = JSON.parse(Buffer.from(fromBase64url(encodedHeader)).toString('utf8'))
  const claims = JSON.parse(Buffer.from(fromBase64url(encodedPayload)).toString('utf8')) as OidcClaims

  /*
   * The algorithm comes from our list, not from the token.
   *
   * `alg: none` and the HMAC-with-the-public-key confusion are both attacks on
   * a verifier that reads its algorithm out of the header it is verifying. Only
   * RS256 is accepted - it is what every provider signs with, and adding others
   * on request is safer than accepting whatever arrives.
   */
  if (String(header?.alg) !== 'RS256')
    throw new Error(`the id_token is signed with ${header?.alg}, and only RS256 is accepted`)

  const key = await keyFor(endpoints.jwks_uri, String(header?.kid ?? ''), now)

  if (!key)
    throw new Error('the provider does not publish the key this token names')

  const imported = await crypto.subtle.importKey(
    'jwk',
    { ...key, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    imported,
    fromBase64url(encodedSignature) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  )

  if (!valid)
    throw new Error('the id_token signature does not verify')

  if (String(claims.iss ?? '') !== endpoints.issuer)
    throw new Error('the id_token was issued by a different provider')

  // `aud` is a string or an array, and both are ordinary. A token minted for a
  // different application at the same provider is the confused-deputy case, and
  // this is the only check that catches it.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]

  if (!audience.map(String).includes(config.clientId))
    throw new Error('the id_token was issued for a different application')

  if (!Number.isFinite(claims.exp) || claims.exp * 1000 + CLOCK_SKEW * 1000 < now)
    throw new Error('the id_token has expired')

  // What stops a token captured from another sign-in being replayed into ours.
  if (String(claims.nonce ?? '') !== expectedNonce)
    throw new Error('the id_token does not answer this sign-in')

  if (!String(claims.sub ?? ''))
    throw new Error('the id_token carries no subject')

  return claims
}
