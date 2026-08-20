/**
 * AT Protocol OAuth: the signature step, done the way the protocol actually
 * does it.
 *
 * The earlier note in this directory said a session needs "a challenge signed
 * by the account's key at its PDS". That was the right instinct and the wrong
 * mechanism: the account's signing key signs *repository commits*, and there is
 * no endpoint that will sign an arbitrary nonce for a third party. The proof
 * that somebody controls an identity is an OAuth authorization at their own
 * server, and everything below exists to make that proof unforgeable by
 * anybody standing in the middle of it.
 *
 * Four mechanisms, each closing a specific hole:
 *
 * - **Discovery from the identity, not from the caller.** The authorization
 *   server is found by resolving the DID to its PDS and asking that PDS. A
 *   caller who could name the server could stand up their own and have it
 *   assert any DID they liked.
 * - **PKCE (S256)**, so an intercepted authorization code is useless without
 *   the verifier that never left this process.
 * - **DPoP**, so an intercepted *token* is useless without the key it was bound
 *   to. Mandatory here rather than optional, and the nonce the server hands back
 *   has to be replayed on the next request.
 * - **`sub` checked against the identity the flow started from.** The last and
 *   most important: the token response names a DID, and if it is not the DID
 *   somebody asked to sign in as, the flow is over. Without this an
 *   authorization server could return anybody.
 */

/** The scopes this instance asks for: identity, and nothing else. */
export const SCOPE = 'atproto'

/** Base64url, without padding, which every JWT part needs. */
export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  for (const byte of view)
    binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A random string of the length the specification asks for. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

/**
 * A PKCE pair.
 *
 * `S256` only: `plain` puts the verifier in the redirect, which is the thing
 * PKCE exists to keep out of it.
 */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  return { verifier, challenge: base64url(digest), method: 'S256' }
}

/** An ES256 keypair, exported so it can be held between two requests. */
export async function createDpopKey(): Promise<{ privateJwk: JsonWebKey, publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)

  // The public JWK goes in every proof header, and a JWK carrying private
  // material there would publish the key the token is bound to.
  delete (publicJwk as any).d
  delete (publicJwk as any).key_ops
  delete (publicJwk as any).ext

  return { privateJwk, publicJwk }
}

/**
 * A DPoP proof for one request.
 *
 * New for every request, with its own `jti`, because a proof is a
 * demonstration that this key is in this process right now - a reused one is a
 * recording somebody else can replay.
 */
export async function dpopProof(input: {
  privateJwk: JsonWebKey
  publicJwk: JsonWebKey
  method: string
  url: string
  nonce?: string | null
  accessToken?: string | null
  now?: number
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    input.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000)

  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: input.publicJwk.kty, crv: input.publicJwk.crv, x: input.publicJwk.x, y: input.publicJwk.y },
  }

  const claims: Record<string, unknown> = {
    jti: randomToken(16),
    htm: input.method.toUpperCase(),
    // The URL without query or fragment, which is what `htu` is defined as -
    // including them makes a proof the server computes differently and rejects.
    htu: input.url.split('?')[0]!.split('#')[0],
    iat: issuedAt,
  }

  if (input.nonce)
    claims.nonce = input.nonce

  if (input.accessToken) {
    // Binds the proof to the token it accompanies, so a proof captured beside
    // one token cannot be presented beside another.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.accessToken))
    claims.ath = base64url(digest)
  }

  const signingInput = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput))

  return `${signingInput}.${base64url(signature)}`
}

export interface AuthorizationServer {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  parEndpoint: string
}

/** Injected in tests; the only way the network is reached. */
export interface OauthFetcher {
  fetchImpl?: typeof fetch
}

/**
 * The authorization server for a PDS.
 *
 * Two hops, both from the specification: the PDS says which resource server
 * metadata to read, and that names the authorization server whose metadata
 * carries the endpoints. Neither is taken from the caller - see the note at the
 * top about why that matters.
 */
export async function discoverAuthorizationServer(pds: string, options: OauthFetcher = {}): Promise<AuthorizationServer | null> {
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const origin = new URL(pds).origin

    const resource = await fetchImpl(`${origin}/.well-known/oauth-protected-resource`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })

    if (!resource.ok)
      return null

    const servers = (await resource.json() as { authorization_servers?: unknown[] })?.authorization_servers ?? []
    const issuer = String(servers[0] ?? '')

    if (!issuer.startsWith('https://'))
      return null

    const metadata = await fetchImpl(`${new URL(issuer).origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })

    if (!metadata.ok)
      return null

    const document = await metadata.json() as Record<string, unknown>

    const server: AuthorizationServer = {
      issuer: String(document.issuer ?? issuer),
      authorizationEndpoint: String(document.authorization_endpoint ?? ''),
      tokenEndpoint: String(document.token_endpoint ?? ''),
      parEndpoint: String(document.pushed_authorization_request_endpoint ?? ''),
    }

    // A server that cannot do PAR cannot be used: the specification requires it,
    // and falling back to a plain authorization request would put the whole
    // request in a URL somebody can rewrite.
    if (!server.authorizationEndpoint || !server.tokenEndpoint || !server.parEndpoint)
      return null

    // The issuer has to be the server that served the metadata, or a redirect
    // could substitute one server's endpoints under another's name.
    if (new URL(server.issuer).origin !== new URL(issuer).origin)
      return null

    return server
  }
  catch {
    return null
  }
}

/** The nonce a server hands back, which the next proof has to carry. */
export function nonceFrom(response: Response): string | null {
  return response.headers.get('dpop-nonce')
}

export interface PushedRequest {
  requestUri: string
  nonce: string | null
}

/**
 * Push the authorization request, and retry once with the nonce.
 *
 * The first PAR of a session is expected to fail with `use_dpop_nonce`: the
 * server has not given one out yet, and it cannot, because the nonce arrives on
 * the response. So one retry is the normal path rather than error handling.
 */
export async function pushAuthorizationRequest(input: {
  server: AuthorizationServer
  clientId: string
  redirectUri: string
  loginHint?: string | null
  state: string
  pkce: Pkce
  dpop: { privateJwk: JsonWebKey, publicJwk: JsonWebKey }
  nonce?: string | null
  fetchImpl?: typeof fetch
}): Promise<PushedRequest | { error: string }> {
  const fetchImpl = input.fetchImpl ?? fetch

  const send = async (nonce: string | null): Promise<Response> => {
    const body = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state: input.state,
      code_challenge: input.pkce.challenge,
      code_challenge_method: input.pkce.method,
    })

    if (input.loginHint)
      body.set('login_hint', input.loginHint)

    return fetchImpl(input.server.parEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'dpop': await dpopProof({ ...input.dpop, method: 'POST', url: input.server.parEndpoint, nonce }),
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
  }

  let answer = await send(input.nonce ?? null)

  if (answer.status === 400 || answer.status === 401) {
    const retryNonce = nonceFrom(answer)

    if (retryNonce)
      answer = await send(retryNonce)
  }

  const nonce = nonceFrom(answer)

  if (!answer.ok)
    return { error: `the authorization server refused the request (${answer.status})` }

  const document = await answer.json().catch(() => null) as { request_uri?: unknown } | null
  const requestUri = String(document?.request_uri ?? '')

  return requestUri ? { requestUri, nonce } : { error: 'the authorization server returned no request_uri' }
}

export interface TokenResult {
  did: string
  scopes: string[]
  accessToken: string
  refreshToken: string | null
  nonce: string | null
}

/**
 * Exchange the code, with DPoP, and check what came back.
 *
 * `expectedDid` is the identity the flow started from. The check against it is
 * the one that cannot be skipped: an authorization server answers with a `sub`,
 * and a server nobody constrained could answer with anybody's.
 */
export async function exchangeCode(input: {
  server: AuthorizationServer
  clientId: string
  redirectUri: string
  code: string
  pkce: { verifier: string }
  dpop: { privateJwk: JsonWebKey, publicJwk: JsonWebKey }
  expectedDid: string
  nonce?: string | null
  fetchImpl?: typeof fetch
}): Promise<TokenResult | { error: string }> {
  const fetchImpl = input.fetchImpl ?? fetch

  const send = async (nonce: string | null): Promise<Response> => fetchImpl(input.server.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'dpop': await dpopProof({ ...input.dpop, method: 'POST', url: input.server.tokenEndpoint, nonce }),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.pkce.verifier,
    }),
    signal: AbortSignal.timeout(8000),
  })

  let answer = await send(input.nonce ?? null)

  if (answer.status === 400 || answer.status === 401) {
    const retryNonce = nonceFrom(answer)

    if (retryNonce)
      answer = await send(retryNonce)
  }

  if (!answer.ok)
    return { error: `the token request was refused (${answer.status})` }

  const document = await answer.json().catch(() => null) as Record<string, unknown> | null

  const did = String(document?.sub ?? '')
  const scopes = String(document?.scope ?? '').split(/\s+/).filter(Boolean)
  const accessToken = String(document?.access_token ?? '')

  if (!did || !accessToken)
    return { error: 'the token response was incomplete' }

  // The check the whole flow is for.
  if (did !== input.expectedDid)
    return { error: 'the authorization server returned a different account than the one signing in' }

  // A session without `atproto` is not one this specification describes, and
  // accepting it would accept whatever else the server meant by it.
  if (!scopes.includes('atproto'))
    return { error: 'the session was granted without the atproto scope' }

  return {
    did,
    scopes,
    accessToken,
    refreshToken: document?.refresh_token ? String(document.refresh_token) : null,
    nonce: nonceFrom(answer),
  }
}
