// The signature step, and the four things that make it a proof.
//
// PKCE so an intercepted code is useless, DPoP so an intercepted token is
// useless, discovery from the identity so the server cannot be chosen by the
// caller, and `sub` checked against the identity the flow started from. The
// last one is the one an implementation can quietly omit and still appear to
// work, so most of this file is about that.

import { describe, expect, test } from 'bun:test'
import {
  base64url,
  createDpopKey,
  createPkce,
  discoverAuthorizationServer,
  dpopProof,
  exchangeCode,
  pushAuthorizationRequest,
  SCOPE,
} from '../../app/Actions/Atproto/oauth'

const SERVER = {
  issuer: 'https://auth.example',
  authorizationEndpoint: 'https://auth.example/authorize',
  tokenEndpoint: 'https://auth.example/token',
  parEndpoint: 'https://auth.example/par',
}

/** A JWT part, decoded. */
function part(jwt: string, index: number): any {
  return JSON.parse(Buffer.from(jwt.split('.')[index]!, 'base64url').toString())
}

describe('PKCE', () => {
  test('is S256, and the challenge is the digest of the verifier', async () => {
    const pkce = await createPkce()

    expect(pkce.method).toBe('S256')

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier))

    expect(pkce.challenge).toBe(base64url(digest))
    // Never the verifier itself: that is what plain does, and it puts the
    // secret in the redirect PKCE exists to keep it out of.
    expect(pkce.challenge).not.toBe(pkce.verifier)
  })

  test('is different every time', async () => {
    const [one, two] = await Promise.all([createPkce(), createPkce()])

    expect(one.verifier).not.toBe(two.verifier)
  })
})

describe('a DPoP proof', () => {
  test('carries the method, the bare URL, and the public key', async () => {
    const dpop = await createDpopKey()
    const proof = await dpopProof({ ...dpop, method: 'post', url: 'https://auth.example/token?x=1#y' })

    expect(part(proof, 0).typ).toBe('dpop+jwt')
    expect(part(proof, 0).alg).toBe('ES256')
    // `htu` is the URL without query or fragment. A proof that includes them is
    // one the server computes differently and rejects.
    expect(part(proof, 1).htu).toBe('https://auth.example/token')
    expect(part(proof, 1).htm).toBe('POST')
  })

  test('never publishes the private half of the key', async () => {
    const dpop = await createDpopKey()
    const proof = await dpopProof({ ...dpop, method: 'POST', url: 'https://auth.example/token' })

    expect(dpop.publicJwk).not.toHaveProperty('d')
    expect(part(proof, 0).jwk).not.toHaveProperty('d')
  })

  test('is new every time, so a captured one cannot be replayed', async () => {
    const dpop = await createDpopKey()
    const one = await dpopProof({ ...dpop, method: 'POST', url: 'https://auth.example/token' })
    const two = await dpopProof({ ...dpop, method: 'POST', url: 'https://auth.example/token' })

    expect(part(one, 1).jti).not.toBe(part(two, 1).jti)
  })

  test('binds to the access token when there is one', async () => {
    const dpop = await createDpopKey()
    const bound = await dpopProof({ ...dpop, method: 'GET', url: 'https://pds.example/x', accessToken: 'token-abc' })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('token-abc'))

    expect(part(bound, 1).ath).toBe(base64url(digest))
  })

  test('verifies against the public key it published', async () => {
    // The proof is only worth anything if it actually signs. Checked here
    // rather than assumed, because a signature nobody verifies is a string.
    const dpop = await createDpopKey()
    const proof = await dpopProof({ ...dpop, method: 'POST', url: 'https://auth.example/token' })

    const [header, claims, signature] = proof.split('.')
    const key = await crypto.subtle.importKey('jwk', dpop.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(signature!, 'base64url'),
      new TextEncoder().encode(`${header}.${claims}`),
    )

    expect(ok).toBe(true)
  })
})

describe('discovery', () => {
  function network(routes: Record<string, unknown>) {
    return (async (url: any) => {
      const body = routes[String(url)]

      return body
        ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
        : new Response('no', { status: 404 })
    }) as unknown as typeof fetch
  }

  test('follows the PDS to its authorization server', async () => {
    const fetchImpl = network({
      'https://pds.example/.well-known/oauth-protected-resource': { authorization_servers: ['https://auth.example'] },
      'https://auth.example/.well-known/oauth-authorization-server': {
        issuer: 'https://auth.example',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        pushed_authorization_request_endpoint: 'https://auth.example/par',
      },
    })

    const server = await discoverAuthorizationServer('https://pds.example', { fetchImpl })

    expect(server?.issuer).toBe('https://auth.example')
    expect(server?.parEndpoint).toBe('https://auth.example/par')
  })

  test('refuses a server that cannot do PAR', async () => {
    // Falling back to a plain authorization request would put the whole request
    // in a URL somebody can rewrite.
    const fetchImpl = network({
      'https://pds.example/.well-known/oauth-protected-resource': { authorization_servers: ['https://auth.example'] },
      'https://auth.example/.well-known/oauth-authorization-server': {
        issuer: 'https://auth.example',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
      },
    })

    expect(await discoverAuthorizationServer('https://pds.example', { fetchImpl })).toBeNull()
  })

  test('refuses metadata whose issuer is a different origin', async () => {
    // Otherwise one server's endpoints can be served under another's name.
    const fetchImpl = network({
      'https://pds.example/.well-known/oauth-protected-resource': { authorization_servers: ['https://auth.example'] },
      'https://auth.example/.well-known/oauth-authorization-server': {
        issuer: 'https://evil.example',
        authorization_endpoint: 'https://evil.example/authorize',
        token_endpoint: 'https://evil.example/token',
        pushed_authorization_request_endpoint: 'https://evil.example/par',
      },
    })

    expect(await discoverAuthorizationServer('https://pds.example', { fetchImpl })).toBeNull()
  })
})

describe('pushing the request', () => {
  test('retries once with the nonce the server hands back', async () => {
    // The first PAR of a session is expected to fail this way: the server has
    // not issued a nonce yet and cannot, because it arrives on the response.
    const seen: Array<string | null> = []

    const fetchImpl = (async (_url: any, init: any) => {
      const proof = String(init.headers.dpop)
      seen.push(part(proof, 1).nonce ?? null)

      if (seen.length === 1) {
        return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
          status: 400,
          headers: { 'dpop-nonce': 'nonce-1' },
        })
      }

      return new Response(JSON.stringify({ request_uri: 'urn:req:abc' }), {
        status: 200,
        headers: { 'dpop-nonce': 'nonce-2', 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await pushAuthorizationRequest({
      server: SERVER,
      clientId: 'https://reviewos.example/atproto/client-metadata.json',
      redirectUri: 'https://reviewos.example/auth/atproto/callback',
      state: 'state-1',
      pkce: await createPkce(),
      dpop: await createDpopKey(),
      fetchImpl,
    })

    expect(result).toMatchObject({ requestUri: 'urn:req:abc', nonce: 'nonce-2' })
    expect(seen).toEqual([null, 'nonce-1'])
  })

  test('asks only for the identity scope', async () => {
    let sent = ''

    const fetchImpl = (async (_url: any, init: any) => {
      sent = String(init.body)

      return new Response(JSON.stringify({ request_uri: 'urn:req:abc' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await pushAuthorizationRequest({
      server: SERVER,
      clientId: 'https://reviewos.example/atproto/client-metadata.json',
      redirectUri: 'https://reviewos.example/auth/atproto/callback',
      state: 'state-1',
      pkce: await createPkce(),
      dpop: await createDpopKey(),
      fetchImpl,
    })

    // This instance learns who somebody is and stops. Asking for
    // `transition:generic` would ask for their records as well.
    expect(new URLSearchParams(sent).get('scope')).toBe(SCOPE)
    expect(sent).not.toContain('transition')
  })
})

describe('exchanging the code', () => {
  function tokenServer(body: Record<string, unknown>) {
    return (async () => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  }

  const base = async () => ({
    server: SERVER,
    clientId: 'https://reviewos.example/atproto/client-metadata.json',
    redirectUri: 'https://reviewos.example/auth/atproto/callback',
    code: 'code-1',
    pkce: { verifier: 'verifier-1' },
    dpop: await createDpopKey(),
  })

  test('accepts a response for the account that started the flow', async () => {
    const result = await exchangeCode({
      ...(await base()),
      expectedDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      fetchImpl: tokenServer({ sub: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', scope: 'atproto', access_token: 'at-1' }),
    })

    expect(result).toMatchObject({ did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' })
  })

  test('refuses a response naming a different account', async () => {
    // The check the whole flow is for. An authorization server nobody
    // constrained could otherwise answer with anybody's DID, and this instance
    // would sign them in as that person.
    const result = await exchangeCode({
      ...(await base()),
      expectedDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      fetchImpl: tokenServer({ sub: 'did:plc:oky5czdrnfjpqslsw2a5iclo', scope: 'atproto', access_token: 'at-1' }),
    })

    expect(result).toMatchObject({ error: expect.stringContaining('different account') })
  })

  test('refuses a session granted without the atproto scope', async () => {
    const result = await exchangeCode({
      ...(await base()),
      expectedDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      fetchImpl: tokenServer({ sub: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', scope: 'transition:generic', access_token: 'at-1' }),
    })

    expect(result).toMatchObject({ error: expect.stringContaining('atproto scope') })
  })

  test('refuses an incomplete response rather than half-believing it', async () => {
    const result = await exchangeCode({
      ...(await base()),
      expectedDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      fetchImpl: tokenServer({ sub: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', scope: 'atproto' }),
    })

    expect(result).toMatchObject({ error: expect.stringContaining('incomplete') })
  })
})
