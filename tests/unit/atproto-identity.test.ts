// Resolving an AT Protocol identity, and the impersonation it has to refuse.
//
// The design in phase 10 rests on one property: a handle is a domain name and
// therefore says whatever its owner wants, so a handle is only an identity when
// the DID document agrees. Most of this file is that property, approached from
// the directions somebody would actually try.

import { describe, expect, test, beforeEach } from 'bun:test'
import {
  didWebDocumentUrl,
  forgetResolved,
  isSupportedDid,
  normalizeHandle,
  readDocument,
  resolveIdentity,
} from '../../app/Actions/Atproto/identity'

/** A DID document, as the directory serves one. */
function document(did: string, handle: string | null, pds = 'https://pds.example') {
  return {
    id: did,
    alsoKnownAs: handle ? [`at://${handle}`] : [],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
    verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', publicKeyMultibase: 'zQ3sh' }],
  }
}

/** A network that answers exactly what the test says and records what was asked. */
function network(routes: Record<string, { status?: number, body?: unknown, text?: string }>) {
  const asked: string[] = []

  const fetchImpl = (async (url: any) => {
    const href = String(url)
    asked.push(href)

    const answer = routes[href]

    if (!answer)
      return new Response('not found', { status: 404 })

    if (typeof answer.text === 'string')
      return new Response(answer.text, { status: answer.status ?? 200 })

    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, asked }
}

/** A resolver that finds nothing, so a test never reaches the real DNS. */
const noRecords = async () => [] as string[][]

beforeEach(() => forgetResolved())

describe('what counts as an identifier', () => {
  test('accepts the two DID methods this understands', () => {
    expect(isSupportedDid('did:plc:ewvi7nxzyoun6zhxrhs64oiz')).toBe(true)
    expect(isSupportedDid('did:web:example.com')).toBe(true)
  })

  test('refuses a method it cannot resolve rather than guessing', () => {
    expect(isSupportedDid('did:key:z6Mk')).toBe(false)
    expect(isSupportedDid('did:plc:TOO-SHORT')).toBe(false)
    expect(isSupportedDid('not-a-did')).toBe(false)
  })

  test('a handle is a domain, and anything else is refused before a fetch', () => {
    expect(normalizeHandle('@Alice.Example')).toBe('alice.example')
    expect(normalizeHandle('alice.example')).toBe('alice.example')
    // These are the ones that matter: a "handle" carrying a slash, an @ or a
    // colon is somebody trying to make this build a URL of their choosing.
    expect(normalizeHandle('alice.example/../evil')).toBeNull()
    expect(normalizeHandle('alice@evil.example')).toBeNull()
    expect(normalizeHandle('alice.example:8080')).toBeNull()
    expect(normalizeHandle('localhost')).toBeNull()
    expect(normalizeHandle('')).toBeNull()
  })
})

describe('did:web', () => {
  test('resolves to the well-known document on its own domain', () => {
    expect(didWebDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json')
  })

  test('and to a path when the DID names one', () => {
    expect(didWebDocumentUrl('did:web:example.com:users:alice')).toBe('https://example.com/users/alice/did.json')
  })

  test('refuses a host that is not one', () => {
    expect(didWebDocumentUrl('did:web:example.com/evil')).toBeNull()
  })
})

describe('reading a document', () => {
  test('takes the handle, the PDS and the keys', () => {
    const identity = readDocument(document('did:plc:ewvi7nxzyoun6zhxrhs64oiz', 'alice.example'))

    expect(identity?.did).toBe('did:plc:ewvi7nxzyoun6zhxrhs64oiz')
    expect(identity?.handle).toBe('alice.example')
    expect(identity?.pds).toBe('https://pds.example')
    expect(identity?.keys[0]?.type).toBe('Multikey')
  })

  test('refuses a document whose id is not a DID it can resolve', () => {
    expect(readDocument({ id: 'did:key:z6Mk' })).toBeNull()
    expect(readDocument({})).toBeNull()
  })
})

describe('resolving, and the impersonation it refuses', () => {
  const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

  test('a handle that the document claims back resolves', async () => {
    const { fetchImpl } = network({
      'https://alice.example/.well-known/atproto-did': { text: did },
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    const identity = await resolveIdentity('alice.example', { fetchImpl, resolveTxt: noRecords })

    expect(identity?.did).toBe(did)
    expect(identity?.handle).toBe('alice.example')
  })

  test('a handle pointed at somebody else’s DID resolves to nothing', async () => {
    // The attack the two-direction check exists for: register a domain, publish
    // a well-known naming a DID you do not own, and sign in as its owner. The
    // document does not claim the handle back, so this is refused.
    const { fetchImpl } = network({
      'https://evil.example/.well-known/atproto-did': { text: did },
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    expect(await resolveIdentity('evil.example', { fetchImpl, resolveTxt: noRecords })).toBeNull()
  })

  test('a DID given directly is resolved without a handle claim', async () => {
    // Starting from the identifier is already unambiguous - it is the account.
    const { fetchImpl } = network({
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    expect((await resolveIdentity(did, { fetchImpl }))?.did).toBe(did)
  })

  test('a directory that answers nothing resolves to nothing rather than throwing', async () => {
    const { fetchImpl } = network({ 'https://alice.example/.well-known/atproto-did': { text: did } })

    expect(await resolveIdentity('alice.example', { fetchImpl, resolveTxt: noRecords })).toBeNull()
  })

  test('nothing is asked of a relay or an AppView', async () => {
    // The dependency phase 10 refused to take: sign-in touches the directory
    // and the handle's own domain, and nothing that anybody else operates.
    const { fetchImpl, asked } = network({
      'https://alice.example/.well-known/atproto-did': { text: did },
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    await resolveIdentity('alice.example', { fetchImpl, resolveTxt: noRecords })

    expect(asked).toHaveLength(2)
    expect(asked.some(url => url.includes('bsky.network') || url.includes('bsky.app'))).toBe(false)
  })

  test('a handle that publishes only a DNS record resolves', async () => {
    /*
     * The case that fixtures agreed with and reality did not.
     *
     * The first version asked only for `/.well-known/atproto-did`, its tests
     * passed, and it then resolved none of `bsky.app`, `jay.bsky.team` or
     * `atproto.com` - because handles publish `_atproto` as a TXT record and
     * mostly serve no well-known path at all. TXT is tried first now, and this
     * is the test that would have caught it.
     */
    const { fetchImpl, asked } = network({
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    const resolveTxt = async (name: string) => {
      expect(name).toBe('_atproto.alice.example')

      // Split into several strings, the way a resolver hands back a long one.
      return [['did=', did]]
    }

    const identity = await resolveIdentity('alice.example', { fetchImpl, resolveTxt })

    expect(identity?.did).toBe(did)
    // And no well-known request was needed.
    expect(asked.some(url => url.includes('.well-known'))).toBe(false)
  })

  test('a DNS answer is still checked against the document', async () => {
    // TXT is a claim like any other: whoever controls the zone says what they
    // like, so the document still has to claim the handle back.
    const { fetchImpl } = network({
      [`https://plc.directory/${did}`]: { body: document(did, 'someone-else.example') },
    })

    const resolveTxt = async () => [[`did=${did}`]]

    expect(await resolveIdentity('alice.example', { fetchImpl, resolveTxt })).toBeNull()
  })

  test('no resolver, or no record, falls through to the well-known path', async () => {
    const { fetchImpl } = network({
      'https://alice.example/.well-known/atproto-did': { text: did },
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    const resolveTxt = async () => {
      throw new Error('no resolver here')
    }

    expect((await resolveIdentity('alice.example', { fetchImpl, resolveTxt }))?.did).toBe(did)
  })

  test('a second resolution is served from the cache', async () => {
    const { fetchImpl, asked } = network({
      'https://alice.example/.well-known/atproto-did': { text: did },
      [`https://plc.directory/${did}`]: { body: document(did, 'alice.example') },
    })

    await resolveIdentity('alice.example', { fetchImpl, resolveTxt: noRecords })
    await resolveIdentity('alice.example', { fetchImpl, resolveTxt: noRecords })

    expect(asked).toHaveLength(2)
  })
})
