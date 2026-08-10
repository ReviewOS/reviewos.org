// Single sign-on, against a real provider.
//
// The provider here is a conforming OIDC issuer served on localhost: a
// discovery document, a JWKS, and a token endpoint that mints `id_token`s
// signed with a key pair generated in `beforeAll`. That is not a stub of the
// thing under test - the thing under test is *our verification*, and a provider
// that signs real RS256 tokens exercises it exactly as a company's Okta would.
//
// Which matters, because the failures worth catching here are all silent. A
// verifier that skips the audience check works perfectly against a well-behaved
// provider and hands the instance to anybody with an account at the same one.
// Every negative test below is a check that a well-behaved provider would never
// trigger.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import process from 'node:process'

const created = {
  userIds: [] as number[],
  organizationId: 0,
  teamIds: [] as number[],
}

let available = false
let port = 0
let server: any = null
let providerPort = 0
let provider: any = null
let signingKey: CryptoKeyPair | null = null
let publicJwk: any = null

/** What the provider will assert on the next token it mints. */
let nextClaims: Record<string, unknown> = {}
let signWith: 'good' | 'wrong-key' = 'good'

/**
 * The one organization whose teams the provider manages.
 *
 * Named up front because it goes into the environment before the server starts
 * and into the fixture after - and a slug is only unique inside an
 * organization, so "which organization" is the whole safety property of the
 * group mapping rather than a detail of the fixture.
 */
const organizationHandle = `ssoorg${Date.now()}`
let wrongKey: CryptoKeyPair | null = null

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input

  return Buffer.from(bytes).toString('base64url')
}

/** An `id_token`, signed the way a provider signs one. */
async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }))
  const payload = base64url(JSON.stringify(claims))
  const key = (signWith === 'good' ? signingKey : wrongKey)!.privateKey

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`) as unknown as ArrayBuffer,
  )

  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

/**
 * Walk the whole flow and return where the browser ended up.
 *
 * One helper for the whole exchange, because the nonce ties the two legs
 * together: it is minted by the outbound redirect and has to be echoed by the
 * token the provider mints. Two helpers, one starting the flow and one
 * finishing it, would each start their own - which is what the first version of
 * this file did, and every test failed on a nonce mismatch that was the test's
 * fault rather than the code's.
 */
async function signIn(
  overrides: Record<string, unknown> = {},
  options: { echoNonce?: boolean, state?: string } = {},
): Promise<{ status: number, location: string, cookies: string[], body: any }> {
  const start = await fetch(`http://127.0.0.1:${port}/api/auth/sso`, { redirect: 'manual' })
  await start.text()

  if (start.status !== 302)
    return { status: start.status, location: '', cookies: [], body: null }

  const handshake = (start.headers.getSetCookie?.() ?? []).find(one => one.startsWith('sso-handshake=')) ?? ''
  const authorize = new URL(String(start.headers.get('location')))
  const state = options.state ?? authorize.searchParams.get('state') ?? ''

  // What the provider will assert when the token endpoint is called below.
  nextClaims = goodClaims({
    ...(options.echoNonce === false ? {} : { nonce: authorize.searchParams.get('nonce') }),
    ...overrides,
  })

  // The provider would show a login form here. What it does after that is
  // redirect back with a code, which is what this simulates.
  const callback = await fetch(
    `http://127.0.0.1:${port}/api/auth/sso?code=test-code&state=${encodeURIComponent(state)}`,
    {
      redirect: 'manual',
      headers: { Cookie: handshake.split(';')[0] ?? '', Accept: 'application/json' },
    },
  )

  const body = await callback.json().catch(() => null)

  return {
    status: callback.status,
    location: String(callback.headers.get('location') ?? ''),
    cookies: callback.headers.getSetCookie?.() ?? [],
    body,
  }
}

beforeAll(async () => {
  try {
    signingKey = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )

    wrongKey = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )

    publicJwk = { ...await crypto.subtle.exportKey('jwk', signingKey.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' }
    delete publicJwk.key_ops
    delete publicJwk.ext

    // The provider. Discovery, keys, and a token endpoint - the three things an
    // OIDC client talks to.
    provider = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request: Request) {
        const url = new URL(request.url)
        const issuer = `http://127.0.0.1:${providerPort}`

        if (url.pathname === '/.well-known/openid-configuration') {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          })
        }

        if (url.pathname === '/jwks')
          return Response.json({ keys: [publicJwk] })

        if (url.pathname === '/token')
          return Response.json({ access_token: 'provider-access-token', id_token: await mintToken(nextClaims) })

        return new Response('not found', { status: 404 })
      },
    })

    providerPort = Number(provider.port)

    process.env.SSO_ISSUER = `http://127.0.0.1:${providerPort}`
    process.env.SSO_CLIENT_ID = 'reviewos-test'
    process.env.SSO_CLIENT_SECRET = 'a-client-secret'
    process.env.SSO_TEAM_ORGANIZATION = organizationHandle

    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('sso_identities').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    process.env.SSO_REDIRECT_URI = `http://127.0.0.1:${port}/api/auth/sso`

    // Two teams whose slugs a group can name, in the one organization the
    // provider is allowed to manage.
    const organization: any = await db
      .insertInto('organizations')
      .values({ handle: organizationHandle, name: 'SSO Org' })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    for (const slug of ['platform', 'security']) {
      const team: any = await db
        .insertInto('teams')
        .values({ organization_id: created.organizationId, name: slug, slug })
        .returning(['id'])
        .executeTakeFirst()

      created.teamIds.push(Number(team?.id))
    }

    available = true
  }
  catch (error) {
    console.warn(`[sso] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.userIds.length > 0) {
        await db.deleteFrom('team_members').where('user_id', 'in', created.userIds).execute()
        await db.deleteFrom('sso_identities').where('user_id', 'in', created.userIds).execute()
        await db.deleteFrom('audit_events').where('actor_id', 'in', created.userIds).execute()
        await db.deleteFrom('notifications').where('user_id', 'in', created.userIds).execute()
        // Refresh tokens hang off the access token, not off the user - there is
        // no `user_id` column on that table.
        const tokens: any[] = await db
          .selectFrom('oauth_access_tokens')
          .select(['id'])
          .where('user_id', 'in', created.userIds)
          .execute()

        if (tokens.length > 0) {
          await db
            .deleteFrom('oauth_refresh_tokens')
            .where('access_token_id', 'in', tokens.map((row: any) => Number(row.id)))
            .execute()
        }

        await db.deleteFrom('oauth_access_tokens').where('user_id', 'in', created.userIds).execute()
        await db.deleteFrom('users').where('id', 'in', created.userIds).execute()
      }

      for (const id of created.teamIds)
        await db.deleteFrom('teams').where('id', '=', id).execute()

      if (created.organizationId)
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()
    }
  }
  finally {
    server?.stop?.()
    provider?.stop?.()

    for (const name of ['SSO_ISSUER', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET', 'SSO_REDIRECT_URI', 'SSO_TEAM_ORGANIZATION'])
      delete process.env[name]
  }
}, 60_000)

/** Claims a well-behaved provider would send, with `overrides` on top. */
function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `http://127.0.0.1:${providerPort}`,
    sub: 'provider-subject-1',
    aud: 'reviewos-test',
    exp: Math.floor(Date.now() / 1000) + 300,
    email: `ssoperson${Date.now()}@example.com`,
    email_verified: true,
    name: 'SSO Person',
    preferred_username: `ssoperson${Date.now()}`,
    ...overrides,
  }
}

describe('the outbound leg', () => {
  test('redirects to the provider with everything the protocol needs', async () => {
    if (!available)
      return

    const start = await fetch(`http://127.0.0.1:${port}/api/auth/sso`, { redirect: 'manual' })
    await start.text()

    expect(start.status).toBe(302)

    const url = new URL(String(start.headers.get('location')))

    expect(url.origin).toBe(`http://127.0.0.1:${providerPort}`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('reviewos-test')
    expect(String(url.searchParams.get('scope'))).toContain('openid')

    /*
     * PKCE, even though this is a confidential client with a secret. The cost
     * is one hash and it closes code interception at the redirect - "we have a
     * client secret" is the reasoning behind most omissions and it does not
     * cover the redirect leg at all.
     */
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(String(url.searchParams.get('code_challenge')).length).toBeGreaterThan(20)

    // And the two values the callback will be checked against.
    expect(String(url.searchParams.get('state')).length).toBeGreaterThan(20)
    expect(String(url.searchParams.get('nonce')).length).toBeGreaterThan(20)

    // The handshake rides in a signed cookie rather than a table, so a sign-in
    // begun on one instance can finish on another.
    const handshake = (start.headers.getSetCookie?.() ?? []).find(one => one.startsWith('sso-handshake='))
    expect(handshake).toBeDefined()
    expect(String(handshake)).toContain('HttpOnly')
  }, 30_000)
})

describe('coming back', () => {
  test('provisions somebody who has never been here', async () => {
    if (!available)
      return

    const answer = await signIn()

    expect(answer.status).toBe(303)
    expect(answer.cookies.join(' ')).toContain('=')

    const db = (globalThis as any).db
    const identity: any = await db
      .selectFrom('sso_identities')
      .selectAll()
      .where('subject', '=', 'provider-subject-1')
      .executeTakeFirst()

    expect(identity).toBeDefined()
    created.userIds.push(Number(identity.user_id))

    // Keyed on `sub`, and the issuer is part of the key - `sub` is only unique
    // within a provider.
    expect(String(identity.issuer)).toBe(`http://127.0.0.1:${providerPort}`)

    const user: any = await db.selectFrom('users').selectAll().where('id', '=', Number(identity.user_id)).executeTakeFirst()

    expect(String(user.handle)).toStartWith('ssoperson')

    /*
     * No usable password. There is nothing to set it to, and `''` is not a
     * bcrypt digest - so a provisioned account cannot be signed into through
     * the password form until somebody deliberately sets one.
     */
    expect(String(user.password ?? '')).toBe('')
  }, 30_000)

  test('signs the same person in again rather than making a second account', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const before: any[] = await db.selectFrom('sso_identities').select(['id']).where('subject', '=', 'provider-subject-1').execute()

    // A new email and a new preferred username, same `sub`. This is somebody
    // who married, or whose company renamed its domain - and the whole reason
    // the lookup is on `sub` is that it must not strand their history.
    expect((await signIn({ email: 'renamed@example.com', preferred_username: 'renamed' })).status).toBe(303)

    const after: any[] = await db.selectFrom('sso_identities').select(['id', 'email']).where('subject', '=', 'provider-subject-1').execute()

    expect(after.length).toBe(before.length)
    expect(String(after[0].email)).toBe('renamed@example.com')
  }, 30_000)

  test('links to an existing local account by verified email, once', async () => {
    if (!available)
      return

    /*
     * Turning single sign-on on at an instance that already has accounts must
     * not give everybody a second empty one. This is the single place email is
     * consulted, and only for an address the provider says it verified - an
     * unverified address is a string somebody typed into a profile page.
     */
    const db = (globalThis as any).db
    const email = `existing${Date.now()}@example.com`

    const local: any = await db
      .insertInto('users')
      .values({ handle: `existing${Date.now()}`, name: 'Already Here', email, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userIds.push(Number(local.id))

    expect((await signIn({ sub: 'provider-subject-2', email, email_verified: true })).status).toBe(303)

    const identity: any = await db
      .selectFrom('sso_identities')
      .selectAll()
      .where('subject', '=', 'provider-subject-2')
      .executeTakeFirst()

    expect(Number(identity.user_id)).toBe(Number(local.id))
  }, 30_000)

  test('will not link on an unverified email', async () => {
    if (!available)
      return

    // Otherwise anybody with an account at the provider claims any local
    // account by editing their own email address.
    const db = (globalThis as any).db
    const email = `unverified${Date.now()}@example.com`

    const local: any = await db
      .insertInto('users')
      .values({ handle: `unverified${Date.now()}`, name: 'Not Yours', email, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userIds.push(Number(local.id))

    expect((await signIn({ sub: 'provider-subject-3', email, email_verified: false })).status).toBe(303)

    const identity: any = await db
      .selectFrom('sso_identities')
      .selectAll()
      .where('subject', '=', 'provider-subject-3')
      .executeTakeFirst()

    expect(Number(identity.user_id)).not.toBe(Number(local.id))
    created.userIds.push(Number(identity.user_id))
  }, 30_000)
})

describe('what it refuses', () => {
  test('a token signed with a key the provider does not publish', async () => {
    if (!available)
      return

    // The check without which an `id_token` is a JSON object anybody can write.
    signWith = 'wrong-key'

    const answer = await signIn({ sub: 'provider-subject-4' })

    signWith = 'good'

    expect(answer.status).toBe(400)
    expect(String(answer.body?.error)).toContain('signature')
  }, 30_000)

  test('a token minted for a different application at the same provider', async () => {
    if (!available)
      return

    /*
     * The confused deputy, and the check people miss. Everything else about
     * this token is genuine - correct issuer, real signature, live key - and it
     * was issued to somebody else's application.
     */
    const answer = await signIn({ sub: 'provider-subject-5', aud: 'some-other-application' })

    expect(answer.status).toBe(400)
    expect(String(answer.body?.error)).toContain('different application')
  }, 30_000)

  test('a token from a different issuer', async () => {
    if (!available)
      return

    const answer = await signIn({ sub: 'provider-subject-6', iss: 'https://somewhere-else.example.com' })

    expect(String(answer.body?.error)).toContain('different provider')
  }, 30_000)

  test('an expired token', async () => {
    if (!available)
      return

    const answer = await signIn({ sub: 'provider-subject-7', exp: Math.floor(Date.now() / 1000) - 3600 })

    expect(String(answer.body?.error)).toContain('expired')
  }, 30_000)

  test('a token answering somebody else sign-in', async () => {
    if (!available)
      return

    // The replay check. Without the nonce, a token captured from another
    // sign-in at the same provider is a way into this one.
    const answer = await signIn({ sub: 'provider-subject-8', nonce: 'not-the-nonce-we-sent' }, { echoNonce: false })

    expect(String(answer.body?.error)).toContain('does not answer this sign-in')
  }, 30_000)

  test('a callback with a state this browser never sent', async () => {
    if (!available)
      return

    /*
     * Login CSRF, which is quieter and worse than the reverse: an attacker
     * hands somebody a callback URL carrying the attacker's own authorization
     * code, and the victim ends up signed into the attacker's account without
     * noticing.
     */
    const start = await fetch(`http://127.0.0.1:${port}/api/auth/sso`, { redirect: 'manual' })
    await start.text()

    const handshake = (start.headers.getSetCookie?.() ?? []).find(one => one.startsWith('sso-handshake=')) ?? ''

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/sso?code=test-code&state=invented-by-somebody-else`, {
      redirect: 'manual',
      headers: { Cookie: handshake.split(';')[0] ?? '', Accept: 'application/json' },
    })

    expect(answer.status).toBe(400)
    expect(String((await answer.json()).error)).toContain('did not start here')
  }, 30_000)

  test('a callback with no handshake at all', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/sso?code=test-code&state=anything`, {
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    })

    expect(answer.status).toBe(400)
  }, 30_000)
})

describe('groups and teams', () => {
  test('joins the teams a group names, and leaves the ones it stops naming', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    expect((await signIn({ sub: 'provider-subject-groups', groups: ['platform', 'security'] })).status).toBe(303)

    const identity: any = await db
      .selectFrom('sso_identities')
      .selectAll()
      .where('subject', '=', 'provider-subject-groups')
      .executeTakeFirst()

    const userId = Number(identity.user_id)
    created.userIds.push(userId)

    const held = async (): Promise<number[]> => {
      const rows: any[] = await db.selectFrom('team_members').select(['team_id']).where('user_id', '=', userId).execute()

      return rows.map(row => Number(row.team_id)).sort()
    }

    expect(await held()).toEqual([...created.teamIds].sort())

    /*
     * And the half that is usually missing. Somebody moves off a team at the
     * identity provider, the group leaves their token, and a mapping that only
     * ever adds leaves their access here exactly as it was - which throws away
     * the entire point of federating, quietly, because everything still works.
     */
    expect((await signIn({ sub: 'provider-subject-groups', groups: ['platform'] })).status).toBe(303)

    expect(await held()).toEqual([created.teamIds[0]!])
  }, 30_000)
})

describe('deprovisioning', () => {
  test('ends every session and every token, and keeps the account', async () => {
    if (!available)
      return

    /*
     * The other half of "removing somebody upstream ends their reach". Taking a
     * grant away already stops a credential reaching a repository on the next
     * request; this stops the credential itself existing.
     *
     * Both halves are needed and they fail differently. Somebody who leaves an
     * organization keeps their account and should - somebody who leaves the
     * company should not keep a token pasted into a build server.
     */
    const db = (globalThis as any).db

    expect((await signIn({ sub: 'provider-subject-leaver', preferred_username: 'leaver' })).status).toBe(303)

    const identity: any = await db
      .selectFrom('sso_identities')
      .selectAll()
      .where('subject', '=', 'provider-subject-leaver')
      .executeTakeFirst()

    const userId = Number(identity.user_id)
    created.userIds.push(userId)

    // A personal access token as well as the session, because forgetting the
    // token is exactly how a credential outlives an account.
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    await db.insertInto('access_tokens').values({
      user_id: userId,
      name: 'a build server',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).execute()

    const counts = async () => ({
      sessions: (await db.selectFrom('oauth_access_tokens').select(['id']).where('user_id', '=', userId).execute()).length,
      tokens: (await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', userId).execute()).length,
      refresh: (await db.selectFrom('oauth_refresh_tokens').selectAll().execute()).length,
    })

    const before = await counts()
    expect(before.sessions).toBeGreaterThan(0)
    expect(before.tokens).toBe(1)

    const { revokeEverything } = await import('../../app/Actions/Auth/provision')
    const revoked = await revokeEverything(userId)

    expect(revoked.sessions).toBe(before.sessions)
    expect(revoked.tokens).toBe(1)

    const after = await counts()
    expect(after.sessions).toBe(0)
    expect(after.tokens).toBe(0)

    /*
     * And no orphaned refresh tokens. `oauth_refresh_tokens` has no `user_id` -
     * it hangs off the access token - so a revoke written the obvious way
     * throws there, gets caught, deletes the access tokens anyway, and leaves
     * the refresh tokens behind. A refresh token outliving its session is
     * exactly the failure this function is named after.
     */
    expect(after.refresh).toBeLessThanOrEqual(before.refresh - before.sessions)

    // The account survives. Deleting it would take their review history and
    // every comment with it, and "this person has left" is not the same
    // statement as "this work never happened".
    const still: any = await db.selectFrom('users').select(['id']).where('id', '=', userId).executeTakeFirst()
    expect(still).toBeDefined()
  }, 60_000)
})
