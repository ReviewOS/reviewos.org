import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { discover, exchangeCode, startAuthorization, verifyIdToken } from './oidc'
import { provisionFromClaims } from './provision'
import { clearedCookie, isSecureRequest, safeRedirect, sessionCookie, sessionCookieName } from './session'

/**
 * Single sign-on: start the redirect, and come back from it.
 *
 * One action handling both legs, because they are two halves of one exchange
 * and every value the second leg checks is one the first leg minted. Splitting
 * them across files is how a `nonce` gets generated in one place and forgotten
 * in the other.
 *
 * **The three secrets ride in a signed cookie**, the same shape as the
 * two-factor challenge: `state`, `nonce` and the PKCE verifier, signed with the
 * application key and good for ten minutes. No table, nothing to expire,
 * nothing for a second process to fail to see - and a sign-in begun on one
 * instance behind a load balancer can finish on another, which a server-side
 * store would break at exactly the moment somebody adds a second instance.
 */
export default new Action({
  name: 'Sso',
  description: 'Sign in through an OpenID Connect provider',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    code: { rule: schema.string() },
    next: { rule: schema.string() },
    state: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const config = ssoConfig()

    if (!config)
      return response.json({ error: 'Single sign-on is not configured on this instance.' }, 404)

    try {
      const endpoints = await discover(config.issuer)
      const code = String(request.get('code') ?? '')

      // No code means this is the outbound leg: mint the secrets and redirect.
      if (!code)
        return await begin(request, config, endpoints)

      return await finish(request, config, endpoints, code)
    }
    catch (error) {
      /*
       * The message is shown, and that is deliberate.
       *
       * These failures are read by an operator wiring up a provider, and the
       * information they leak is about *our own configuration* rather than
       * about any account - "the id_token was issued for a different
       * application" tells an attacker nothing they did not already know and
       * saves somebody an afternoon.
       */
      const message = error instanceof Error ? error.message : String(error)

      console.error('[sso] sign-in failed:', message)

      return response.json({ error: `Single sign-on failed: ${message}` }, 400)
    }
  },
})

const HANDSHAKE_COOKIE = 'sso-handshake'

/** Ten minutes: long enough to type a password at the provider and be prompted for a factor. */
const HANDSHAKE_TTL_MS = 10 * 60 * 1000

/** Send the browser to the provider, remembering what we sent. */
async function begin(request: any, config: ReturnType<typeof ssoConfig> & object, endpoints: any): Promise<Response> {
  const started = await startAuthorization(config, endpoints)

  const payload = JSON.stringify({
    state: started.state,
    nonce: started.nonce,
    verifier: started.codeVerifier,
    next: safeRedirect(request.get('next'), '/reviews'),
    exp: Date.now() + HANDSHAKE_TTL_MS,
  })

  const cookie = sessionCookie(HANDSHAKE_COOKIE, sign(payload), {
    maxAgeSeconds: HANDSHAKE_TTL_MS / 1000,
    secure: isSecureRequest(request),
  })

  return new Response(null, {
    status: 302,
    headers: { 'Location': started.url, 'Set-Cookie': cookie },
  })
}

/** Come back from the provider: check everything, then sign somebody in. */
async function finish(request: any, config: ReturnType<typeof ssoConfig> & object, endpoints: any, code: string): Promise<Response> {
  const handshake = unsign(cookieValue(request, HANDSHAKE_COOKIE))

  if (!handshake)
    return response.json({ error: 'This sign-in has expired. Start again.' }, 400)

  /*
   * `state` first, before the code is spent.
   *
   * It is what proves this callback answers a sign-in *this browser* started -
   * without it, an attacker can hand somebody a callback URL carrying their own
   * authorization code and log the victim into the attacker's account, which is
   * quieter and worse than the reverse.
   */
  const state = String(request.get('state') ?? '')

  if (!state || !constantEquals(state, handshake.state))
    return response.json({ error: 'This sign-in did not start here.' }, 400)

  const { idToken } = await exchangeCode(config, endpoints, code, handshake.verifier)
  const claims = await verifyIdToken(idToken, config, endpoints, handshake.nonce)
  const provisioned = await provisionFromClaims(claims, endpoints.issuer)

  const { Auth } = await import('@stacksjs/auth')
  const issued: any = await Auth.loginUsingId(provisioned.userId, {
    userAgent: String(request?.headers?.get?.('user-agent') ?? '') || null,
    ipAddress: String(request?.headers?.get?.('x-forwarded-for') ?? '').split(',')[0]?.trim() || null,
  })

  if (!issued?.token)
    return response.json({ error: 'Signed in at the provider, but this instance could not start a session.' }, 500)

  await auditEvent(provisioned.created ? 'sso:provisioned' : 'sso:signed-in', {
    subject: { type: 'user', id: provisioned.userId },
    actorId: provisioned.userId,
    ...await auditFrom(request),
    detail: {
      issuer: endpoints.issuer,
      subject: claims.sub,
      teams_joined: provisioned.teamsJoined,
      teams_left: provisioned.teamsLeft,
    },
  })

  const secure = isSecureRequest(request)
  const headers = new Headers()

  headers.append('Set-Cookie', sessionCookie(await sessionCookieName(), String(issued.token), {
    maxAgeSeconds: Number(issued.expiresIn ?? 60 * 60 * 24 * 7),
    secure,
  }))

  // The handshake is spent. Left behind, its `state` would still match a
  // second callback carrying a different code.
  headers.append('Set-Cookie', clearedCookie(HANDSHAKE_COOKIE, secure))
  headers.set('Location', handshake.next)

  return new Response(null, { status: 303, headers })
}

export interface SsoConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string[]
}

/**
 * The provider, from the environment.
 *
 * Environment rather than the settings table: a client secret in the database
 * is a client secret in every backup and every dump, and the settings table is
 * explicitly for things that are not secrets. Returns null when unconfigured,
 * which is what makes the endpoint answer 404 rather than half-work.
 */
export function ssoConfig(): SsoConfig | null {
  const issuer = String(process.env.SSO_ISSUER ?? '').trim().replace(/\/$/, '')
  const clientId = String(process.env.SSO_CLIENT_ID ?? '').trim()
  const clientSecret = String(process.env.SSO_CLIENT_SECRET ?? '').trim()

  if (!issuer || !clientId || !clientSecret)
    return null

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: String(process.env.SSO_REDIRECT_URI ?? '').trim()
      || `${String(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/auth/sso`,
    scopes: String(process.env.SSO_SCOPES ?? '').split(/[\s,]+/).filter(Boolean),
  }
}

/** `payload.signature`, base64url, signed with the application key. */
function sign(payload: string): string {
  const body = Buffer.from(payload, 'utf8').toString('base64url')

  return `${body}.${createHmac('sha256', applicationKey()).update(body).digest('hex')}`
}

interface Handshake { state: string, nonce: string, verifier: string, next: string, exp: number }

function unsign(value: string): Handshake | null {
  const [body, signature] = String(value ?? '').split('.')

  if (!body || !signature)
    return null

  const expected = createHmac('sha256', applicationKey()).update(body).digest('hex')

  if (!constantEquals(expected, signature))
    return null

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Handshake

    return Number(parsed.exp) > Date.now() ? parsed : null
  }
  catch {
    return null
  }
}

/** Compared in constant time: `state` is a secret for the length of a redirect. */
function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')

  return left.length === right.length && timingSafeEqual(left, right)
}

let ephemeralKey = ''

function applicationKey(): string {
  const configured = String(process.env.APP_KEY ?? '').trim()

  if (configured)
    return configured

  if (!ephemeralKey)
    ephemeralKey = randomBytes(32).toString('hex')

  return ephemeralKey
}

function cookieValue(request: any, name: string): string {
  const header = String(request?.headers?.get?.('cookie') ?? request?.header?.('cookie') ?? '')

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')

    if (key === name)
      return decodeURIComponent(rest.join('='))
  }

  return ''
}
