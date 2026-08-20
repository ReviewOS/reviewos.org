/**
 * Resolving an AT Protocol identity, which is the whole of the federation this
 * instance does.
 *
 * Phase 10's decision, in code: **identity portability, not content
 * federation**. There is no inbox here, no outbox, no delivery queue and
 * nothing that replicates an issue or a review. Somebody arrives with a handle,
 * this instance works out which permanent identifier it names and whether that
 * identifier claims the handle back, and from then on they are a local account
 * that this instance did not issue and cannot hold hostage.
 *
 * ## Why the check runs in both directions
 *
 * A handle is a domain name and therefore says whatever its owner wants. The
 * identifier is the account. So `resolveHandle` is only half an answer: it says
 * "alice.example claims to be did:plc:xyz", and anybody can put that claim in
 * their own DNS. The other half is fetching the DID document and finding the
 * handle listed in `alsoKnownAs` - the account agreeing that the handle is its
 * own. Without that second direction, registering `chris.example` and pointing
 * it at somebody else's DID would let you sign in as them.
 *
 * ## What this deliberately does not depend on
 *
 * Relays and AppViews. Nothing here subscribes to a firehose or asks an
 * aggregator anything, because a self-hosted forge may not have its sign-in
 * page wait on infrastructure its operator does not run. Resolution touches the
 * PLC directory (for `did:plc`) or the handle's own domain (for `did:web`), and
 * both are cached - so a directory that is slow makes a first sign-in slow and
 * makes nothing else happen at all.
 */

/** The directory `did:plc` resolves through. Overridable for a private network. */
export const PLC_DIRECTORY = 'https://plc.directory'

/** How long a resolved document is trusted. */
export const CACHE_TTL_MS = 10 * 60 * 1000

export interface AtprotoIdentity {
  did: string
  /** The handle the document itself claims, which is the one to display. */
  handle: string | null
  /** Where this account's repository lives, from the service entry. */
  pds: string | null
  /** The verification methods, so a signature can be checked later. */
  keys: Array<{ id: string, type: string, publicKeyMultibase?: string }>
}

interface Cached {
  identity: AtprotoIdentity
  at: number
}

const cache = new Map<string, Cached>()

/** Injected in tests, and the only way the network is reached. */
export interface Fetcher {
  fetchImpl?: typeof fetch
  directory?: string
  now?: number
  /** The TXT lookup, so a test can answer without a resolver. */
  resolveTxt?: (name: string) => Promise<string[][]>
}

/** A syntactically valid DID of a method this understands. */
export function isSupportedDid(value: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(value) || /^did:web:[a-z0-9.:%-]+$/i.test(value)
}

/**
 * A handle, normalised, or null when it is not one.
 *
 * A handle is a domain, so the rules are a domain's: labels of letters, digits
 * and hyphens, at least one dot, no trailing dot, and short enough to be one.
 * Rejected here rather than passed to a fetch, because a "handle" carrying a
 * slash or an @ is somebody trying to make this build a URL they chose.
 */
export function normalizeHandle(value: string): string | null {
  const handle = String(value ?? '').trim().toLowerCase().replace(/^@/, '')

  if (handle.length === 0 || handle.length > 253)
    return null

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(handle))
    return null

  return handle
}

/** `did:web:example.com` -> `https://example.com/.well-known/did.json`. */
export function didWebDocumentUrl(did: string): string | null {
  if (!did.startsWith('did:web:'))
    return null

  const rest = decodeURIComponent(did.slice('did:web:'.length))
  const [host, ...path] = rest.split(':')

  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host))
    return null

  return path.length > 0
    ? `https://${host}/${path.join('/')}/did.json`
    : `https://${host}/.well-known/did.json`
}

/** The DID document for a DID, from the directory or from the domain. */
export async function fetchDocument(did: string, options: Fetcher = {}): Promise<any | null> {
  // Checked here as well as by the caller, because this is exported: the DID
  // goes into a URL unescaped - the directory expects `did:plc:xyz`, not a
  // percent-encoded copy of it - so the shape has to be known first.
  if (!isSupportedDid(did))
    return null

  const fetchImpl = options.fetchImpl ?? fetch
  const url = did.startsWith('did:plc:')
    ? `${options.directory ?? PLC_DIRECTORY}/${did}`
    : didWebDocumentUrl(did)

  if (!url)
    return null

  try {
    const answer = await fetchImpl(url, {
      headers: { accept: 'application/did+ld+json, application/json' },
      // A sign-in must not hang on somebody else's directory.
      signal: AbortSignal.timeout(5000),
    })

    if (!answer.ok)
      return null

    return await answer.json()
  }
  catch {
    return null
  }
}

/** What a document says about itself, in the shape this instance stores. */
export function readDocument(document: any): AtprotoIdentity | null {
  const did = String(document?.id ?? '')

  if (!isSupportedDid(did))
    return null

  const aka: string[] = Array.isArray(document?.alsoKnownAs) ? document.alsoKnownAs.map(String) : []
  const claimed = aka.find(entry => entry.startsWith('at://'))

  const services: any[] = Array.isArray(document?.service) ? document.service : []
  const pds = services.find(one => String(one?.type ?? '') === 'AtprotoPersonalDataServer')

  const methods: any[] = Array.isArray(document?.verificationMethod) ? document.verificationMethod : []

  return {
    did,
    handle: claimed ? normalizeHandle(claimed.slice('at://'.length)) : null,
    pds: pds?.serviceEndpoint ? String(pds.serviceEndpoint) : null,
    keys: methods.map(one => ({
      id: String(one?.id ?? ''),
      type: String(one?.type ?? ''),
      publicKeyMultibase: one?.publicKeyMultibase ? String(one.publicKeyMultibase) : undefined,
    })),
  }
}

/**
 * The DID a handle claims, by asking the handle's own domain.
 *
 * Two ways, both from the specification, and **both are needed** - which is
 * something only reality said. The first version did the HTTP one alone, on the
 * reasoning that a forge on Bun has HTTP and may not have a resolver worth
 * trusting. Its tests passed. Then it was pointed at three real handles and
 * resolved none of them: `bsky.app` publishes `_atproto` as a DNS TXT record
 * and serves no well-known path at all, and so does nearly every handle that
 * exists. A design that is right about the specification and wrong about the
 * network is wrong.
 *
 * So: TXT first, because that is what handles actually publish, and the
 * well-known path second, because it is what a host behind a CDN with no
 * control of its own DNS can offer. Either answer is verified against the DID
 * document afterwards, so neither is trusted on its own.
 */
export async function didForHandle(handle: string, options: Fetcher = {}): Promise<string | null> {
  const normalized = normalizeHandle(handle)

  if (!normalized)
    return null

  const fromDns = await didFromTxt(normalized, options)

  if (fromDns)
    return fromDns

  const fetchImpl = options.fetchImpl ?? fetch

  try {
    const answer = await fetchImpl(`https://${normalized}/.well-known/atproto-did`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!answer.ok)
      return null

    const did = (await answer.text()).trim()

    return isSupportedDid(did) ? did : null
  }
  catch {
    return null
  }
}

/** The `_atproto` TXT record's `did=` value, when there is one. */
async function didFromTxt(handle: string, options: Fetcher = {}): Promise<string | null> {
  try {
    const resolveTxt = options.resolveTxt ?? (await import('node:dns/promises')).resolveTxt

    // A record may be split into several strings by the resolver, and a name
    // may carry several records: joined within, searched across.
    for (const record of await resolveTxt(`_atproto.${handle}`)) {
      const value = record.join('').trim()

      if (!value.startsWith('did='))
        continue

      const did = value.slice('did='.length).trim()

      if (isSupportedDid(did))
        return did
    }

    return null
  }
  catch {
    // NXDOMAIN, no resolver, a timeout: all of them mean "ask the other way".
    return null
  }
}

/**
 * Resolve an identifier - a handle or a DID - to an identity, verified.
 *
 * The verification is the point, and it is why a handle cannot be trusted on
 * its own: whichever direction the caller started from, the answer is only
 * returned when the document and the handle agree. A handle pointing at
 * somebody else's DID resolves to nothing rather than to them.
 */
export async function resolveIdentity(identifier: string, options: Fetcher = {}): Promise<AtprotoIdentity | null> {
  const now = options.now ?? Date.now()
  const key = String(identifier ?? '').trim().toLowerCase()

  const held = cache.get(key)

  if (held && now - held.at < CACHE_TTL_MS)
    return held.identity

  const did = isSupportedDid(key) ? key : await didForHandle(key, options)

  if (!did)
    return null

  const identity = readDocument(await fetchDocument(did, options))

  if (!identity)
    return null

  // Started from a handle: the document has to claim it back.
  if (!isSupportedDid(key) && identity.handle !== key)
    return null

  cache.set(key, { identity, at: now })

  return identity
}

/** Forget everything resolved. For tests, and for an operator who rotated a DID. */
export function forgetResolved(): void {
  cache.clear()
}
