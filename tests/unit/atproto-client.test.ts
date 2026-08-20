// What this instance says it is, and the configuration that broke it.
//
// `APP_URL` is a bare host in more than one deployment - the framework's own
// default is `reviewos.localhost` - and every URL here is built from it. The
// first version passed it straight to `new URL`, which throws on a host with no
// scheme, so the whole flow failed before it reached the network. Unit tests
// did not catch that; running it did.

import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { appUrl, clientId, clientMetadata, isLocal, redirectUri } from '../../app/Actions/Atproto/client'

/** Set `APP_URL` for one call and put it back. */
function withAppUrl<T>(value: string, run: () => T): T {
  const before = process.env.APP_URL
  process.env.APP_URL = value

  try {
    return run()
  }
  finally {
    if (before === undefined)
      delete process.env.APP_URL
    else
      process.env.APP_URL = before
  }
}

describe('the instance address', () => {
  test('takes a bare host and does not throw on it', () => {
    // The exact value that broke this, and the reason the function exists.
    expect(withAppUrl('reviewos.localhost', appUrl)).toBe('http://reviewos.localhost')
    expect(withAppUrl('reviewos.localhost', redirectUri)).toContain('127.0.0.1')
  })

  test('assumes https for a bare host that is not local', () => {
    // A sign-in redirect that leaves over http is a session handed to whoever
    // is on the path, so the guess has to fall this way.
    expect(withAppUrl('reviewos.org', appUrl)).toBe('https://reviewos.org')
    expect(withAppUrl('reviewos.org', isLocal)).toBe(false)
  })

  test('keeps a scheme that is already there', () => {
    expect(withAppUrl('https://code.example/', appUrl)).toBe('https://code.example')
  })
})

describe('the client identity', () => {
  test('a public instance is identified by the document it serves', () => {
    expect(withAppUrl('https://code.example', clientId)).toBe('https://code.example/atproto/client-metadata.json')
    expect(withAppUrl('https://code.example', redirectUri)).toBe('https://code.example/api/auth/atproto/callback')
  })

  test('a local instance uses the development form, redirecting to 127.0.0.1', () => {
    // `localhost` is refused as a redirect host by the specification because it
    // can resolve anywhere; the loopback address cannot.
    const id = withAppUrl('http://localhost:3000', clientId)

    expect(id.startsWith('http://localhost?')).toBe(true)
    expect(new URL(id).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/api/auth/atproto/callback')
    expect(new URL(id).searchParams.get('scope')).toBe('atproto')
  })

  test('the document asks for identity and nothing else', () => {
    const metadata = withAppUrl('https://code.example', clientMetadata)

    expect(metadata.scope).toBe('atproto')
    expect(metadata.dpop_bound_access_tokens).toBe(true)
    expect(metadata.grant_types).toEqual(['authorization_code'])
    // No refresh: this instance learns who somebody is at sign-in and has no
    // reason to hold a credential that keeps acting as them afterwards.
    expect(metadata.grant_types).not.toContain('refresh_token')
    expect(JSON.stringify(metadata)).not.toContain('transition')
  })

  test('the document contains nothing secret, because it is served to anybody', () => {
    const metadata = withAppUrl('https://code.example', clientMetadata)

    expect(metadata).not.toHaveProperty('client_secret')
    expect(metadata).not.toHaveProperty('jwks')
    expect(metadata.token_endpoint_auth_method).toBe('none')
  })
})
