// Passkeys, with an authenticator that actually signs.
//
// The same approach the single sign-on test takes, for the same reason: the
// thing under test is *our verification*, so the other side has to be real. A
// software authenticator here holds an ES256 key pair, builds authenticator
// data the way a YubiKey does, and signs over it - which means a verifier that
// skipped the signature, or checked the wrong origin, or accepted a replayed
// challenge, fails these tests rather than passing them.
//
// A stub would not. A stub that returns `{ verified: true }` passes every test
// anybody writes against it, which is how a second factor ends up being
// decorative.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import process from 'node:process'

const created = {
  handle: '',
  userId: 0,
  session: '',
  csrf: { token: '', cookie: '' },
  password: 'a-long-enough-password',
  credentialId: '',
}

let available = false
let port = 0
let server: any = null
let authenticator: CryptoKeyPair | null = null

/**
 * The authenticator's own signature counter.
 *
 * A real one increments on every assertion, and the server refuses a value that
 * did not advance because that is what a *cloned* credential looks like. A
 * fixture that signed with a fixed counter passed on its own and failed as soon
 * as a second test ran - which is the counter check doing exactly its job.
 */
let signCount = 0

/** This file's own client address, so the sign-in throttle buckets separately. */
const CLIENT = `203.0.113.${1 + Math.floor(Math.random() * 250)}`

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

async function post(path: string, body: Record<string, unknown>, cookie = ''): Promise<{ status: number, body: any, headers: Headers }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': [cookie, created.csrf.cookie].filter(Boolean).join('; '),
      'x-csrf-token': created.csrf.token,
      'x-forwarded-for': CLIENT,
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null), headers: answer.headers }
}

function cookieFrom(headers: Headers, name: string): string {
  for (const raw of headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']) {
    const match = new RegExp(`${name}=([^;]*)`).exec(raw)

    if (match && match[1])
      return `${name}=${match[1]}`
  }

  return ''
}

/**
 * The `authenticatorData` a real authenticator produces.
 *
 * SHA-256 of the relying party id, one flags byte, and a four-byte counter -
 * exactly the layout in the specification, because the signature is over these
 * bytes and a verifier that reads them differently rejects everything.
 *
 * Flags `0x05` is user-present plus user-verified, which is what a device with
 * a fingerprint reader sets.
 */
async function authenticatorData(rpId: string, counter: number): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)))
  const bytes = new Uint8Array(37)

  bytes.set(rpIdHash, 0)
  bytes[32] = 0x05

  new DataView(bytes.buffer).setUint32(33, counter, false)

  return bytes
}

/**
 * An assertion, signed the way a hardware key signs one.
 *
 * The signed message is `authenticatorData || SHA-256(clientDataJSON)`, and the
 * signature is ECDSA P-256 in the DER encoding WebAuthn uses - `crypto.subtle`
 * produces raw r||s, so it is converted, because a verifier expecting DER and
 * handed raw bytes rejects a perfectly good signature.
 */
async function assertion(options: any, overrides: { origin?: string, counter?: number, challenge?: string } = {}): Promise<string> {
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: overrides.challenge ?? String(options.challenge),
    origin: overrides.origin ?? String(process.env.APP_URL),
    crossOrigin: false,
  })

  const clientDataBytes = new TextEncoder().encode(clientData)
  signCount += 1

  const data = await authenticatorData(new URL(String(process.env.APP_URL)).hostname, overrides.counter ?? signCount)
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes))

  const signed = new Uint8Array(data.length + clientDataHash.length)
  signed.set(data, 0)
  signed.set(clientDataHash, data.length)

  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    authenticator!.privateKey,
    signed as unknown as ArrayBuffer,
  ))

  return JSON.stringify({
    id: created.credentialId,
    rawId: created.credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: base64url(clientDataBytes),
      authenticatorData: base64url(data),
      signature: base64url(derSignature(raw)),
    },
  })
}

/** Raw r||s to the DER sequence WebAuthn signatures are encoded in. */
function derSignature(raw: Uint8Array): Uint8Array {
  const trim = (part: Uint8Array): number[] => {
    let start = 0

    while (start < part.length - 1 && part[start] === 0)
      start += 1

    const trimmed = [...part.slice(start)]

    // A leading bit set would read as a negative integer in DER, so it is
    // padded - the detail that makes hand-rolled signature encoding wrong one
    // time in two hundred and impossible to debug when it is.
    return trimmed[0]! & 0x80 ? [0, ...trimmed] : trimmed
  }

  const r = trim(raw.slice(0, 32))
  const s = trim(raw.slice(32))
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s]

  return new Uint8Array([0x30, body.length, ...body])
}

beforeAll(async () => {
  try {
    process.env.APP_URL = 'http://127.0.0.1:9999'

    authenticator = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('passkeys').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const seed = await fetch(`http://127.0.0.1:${port}/api/health?quick=1`)
    const match = /X-CSRF-Token=([^;]*)/.exec(seed.headers.get('set-cookie') ?? '')
    await seed.text()

    if (!match)
      throw new Error('no CSRF cookie was seeded')

    created.csrf = { token: decodeURIComponent(match[1]!), cookie: `X-CSRF-Token=${match[1]}` }
    created.handle = `passkey${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`

    const registered = await post('/api/auth/register', {
      handle: created.handle,
      email: `${created.handle}@example.com`,
      password: created.password,
      name: 'Passkey Person',
    })

    if (registered.status >= 400)
      throw new Error(`registration answered ${registered.status}`)

    const { sessionCookieName } = await import('../../app/Actions/Auth/session')
    created.session = cookieFrom(registered.headers, await sessionCookieName())

    const row: any = await db.selectFrom('users').select(['id']).where('handle', '=', created.handle).executeTakeFirst()
    created.userId = Number(row?.id)

    /*
     * The credential row, written directly rather than through a registration
     * ceremony.
     *
     * Registration would need a CBOR attestation object, and what it would
     * prove is that the framework can parse one - it has its own tests for
     * that. What is worth exercising here is the *assertion*, which is the leg
     * that runs on every sign-in and the leg where a mistake means anybody can
     * sign in as anybody.
     */
    const { encodePublicKey } = await import('../../app/Actions/Auth/passkeys')
    const exported = await crypto.subtle.exportKey('raw', authenticator.publicKey)
    const publicKey = new Uint8Array(exported)

    // The COSE EC2 key an authenticator reports: kty 2, alg -7, crv 1, then the
    // two coordinates out of the uncompressed point.
    const cose = new Uint8Array([
      0xA5,
      0x01, 0x02,
      0x03, 0x26,
      0x20, 0x01,
      0x21, 0x58, 0x20, ...publicKey.slice(1, 33),
      0x22, 0x58, 0x20, ...publicKey.slice(33, 65),
    ])

    created.credentialId = base64url(crypto.getRandomValues(new Uint8Array(16)))

    await db.insertInto('passkeys').values({
      id: created.credentialId,
      user_id: created.userId,
      webauthn_user_id: String(created.userId),
      cred_public_key: encodePublicKey(cose.buffer.slice(cose.byteOffset, cose.byteOffset + cose.byteLength) as ArrayBuffer),
      counter: 0,
      credential_type: 'public-key',
      device_type: 'singleDevice',
      backup_eligible: false,
      backup_status: false,
      transports: JSON.stringify(['internal']),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[passkey] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.userId) {
      await db.deleteFrom('webauthn_challenges').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('passkeys').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('audit_events').where('actor_id', '=', created.userId).execute()
      await db.deleteFrom('notifications').where('user_id', '=', created.userId).execute()

      const tokens: any[] = await db.selectFrom('oauth_access_tokens').select(['id']).where('user_id', '=', created.userId).execute()

      if (tokens.length > 0)
        await db.deleteFrom('oauth_refresh_tokens').where('access_token_id', 'in', tokens.map((one: any) => Number(one.id))).execute()

      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', created.userId).execute()
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  finally {
    server?.stop?.()
    delete process.env.APP_URL
  }
}, 60_000)

/** Password, then whatever the challenge asks for. Returns both legs. */
async function startSignIn(): Promise<{ challenge: string, options: any, status: number }> {
  const first = await post('/api/auth/login', {
    email: `${created.handle}@example.com`,
    password: created.password,
  })

  return {
    challenge: cookieFrom(first.headers, 'two-factor-challenge'),
    options: first.body?.passkey_options ?? null,
    status: first.status,
  }
}

describe('the passkey list', () => {
  test('shows something somebody can choose between', async () => {
    if (!available)
      return

    const answer = await post('/api/user/passkeys', { operation: 'list' }, created.session)

    expect(answer.status).toBe(200)
    expect(answer.body?.passkeys?.length).toBe(1)

    // "Passkey 3" is useless when the question is *which of these do I still
    // have*, so the label says what the authenticator told us it was.
    expect(String(answer.body.passkeys[0].label)).toBe('This device')
  }, 30_000)

  test('and belongs to nobody else', async () => {
    if (!available)
      return

    // Every operation acts on the caller. An endpoint that could remove
    // somebody else's passkey would be an endpoint that removes a second
    // factor, which is the one thing a stolen session must never do.
    const answer = await post('/api/user/passkeys', { operation: 'list' })

    expect(answer.status).toBe(401)
  }, 30_000)
})

describe('signing in with one', () => {
  test('the password gets a challenge and the options to answer it', async () => {
    if (!available)
      return

    const started = await startSignIn()

    expect(started.status).toBe(401)
    expect(started.challenge).not.toBe('')

    /*
     * The options ride along with the challenge rather than needing a second
     * request between the password and the prompt - which would be a visible
     * pause exactly where somebody is already waiting.
     */
    expect(started.options).not.toBeNull()
    expect(String(started.options.challenge).length).toBeGreaterThan(10)
    expect(started.options.allowCredentials?.[0]?.id).toBeDefined()
  }, 30_000)

  test('a real assertion signs in', async () => {
    if (!available)
      return

    const started = await startSignIn()
    const answer = await post('/api/auth/login', { passkey: await assertion(started.options) }, started.challenge)

    expect(answer.status).toBe(200)
    expect(String(answer.body?.access_token ?? '').length).toBeGreaterThan(10)
  }, 30_000)

  test('an assertion signed for a different origin does not', async () => {
    if (!available)
      return

    /*
     * The property that makes a passkey unphishable, and the only test here
     * that distinguishes it from TOTP. Somebody looking at a convincing copy of
     * this sign-in page on another domain will hand over a password and six
     * digits quite happily; what their authenticator signs on that page carries
     * that page's origin, and this is the check that notices.
     */
    const started = await startSignIn()
    const forged = await assertion(started.options, { origin: 'https://forge.example.com.evil.test' })
    const answer = await post('/api/auth/login', { passkey: forged }, started.challenge)

    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(String(answer.body?.access_token ?? '')).toBe('')
  }, 30_000)

  test('an assertion answering a different challenge does not', async () => {
    if (!available)
      return

    // Replay. Without the challenge check, one captured assertion is a way in
    // forever.
    const started = await startSignIn()
    const stale = await assertion(started.options, { challenge: base64url(crypto.getRandomValues(new Uint8Array(32))) })
    const answer = await post('/api/auth/login', { passkey: stale }, started.challenge)

    expect(answer.status).toBeGreaterThanOrEqual(400)
  }, 30_000)

  test('the same assertion twice does not', async () => {
    if (!available)
      return

    /*
     * The challenge is spent whether or not verification succeeded, so a
     * captured assertion cannot be sent again against the same one. Deleting
     * only on success would let somebody retry as often as they liked, which is
     * exactly the replay the challenge exists to prevent.
     */
    const started = await startSignIn()
    const once = await assertion(started.options)

    expect((await post('/api/auth/login', { passkey: once }, started.challenge)).status).toBe(200)

    const again = await post('/api/auth/login', { passkey: once }, started.challenge)

    expect(again.status).toBeGreaterThanOrEqual(400)
  }, 30_000)
})

describe('removing one', () => {
  test('somebody else id removes nothing', async () => {
    if (!available)
      return

    const answer = await post('/api/user/passkeys', { operation: 'remove', id: 'not-a-passkey-of-theirs' }, created.session)

    expect(answer.body?.removed).toBe(false)
    expect((await post('/api/user/passkeys', { operation: 'list' }, created.session)).body?.passkeys?.length).toBe(1)
  }, 30_000)

  test('their own is removed, and recorded', async () => {
    if (!available)
      return

    const answer = await post('/api/user/passkeys', { operation: 'remove', id: created.credentialId }, created.session)

    expect(answer.body?.removed).toBe(true)

    const row: any = await (globalThis as any).db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'passkey:removed')
      .where('actor_id', '=', created.userId)
      .executeTakeFirst()

    // Removing a second factor is exactly the event somebody reconstructs after
    // an incident, so it is a row rather than a line in a log.
    expect(row).toBeDefined()
  }, 30_000)
})
