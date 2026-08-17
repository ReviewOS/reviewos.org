import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { clearedCookie, isSecureRequest, sessionCookie, sessionCookieName } from './session'
import { STATE_COOKIE } from './SocialRedirectAction'
import { providerFor, provisionFromSocial } from './social'

/**
 * Finish a social sign-in: the provider sent the browser back with a code.
 *
 * Everything refused here is refused *before* a token is exchanged, because an
 * exchange is the point of no return - it burns a one-time code and creates a
 * session somewhere. In order:
 *
 * 1. **A provider we know and that is configured**, or 404. The route pattern
 *    matches any name.
 * 2. **The provider did not report an error.** A visitor who pressed Cancel
 *    arrives here with `error=access_denied` and no code; that is not a
 *    failure to apologise for, so it returns them to the sign-in page quietly.
 * 3. **The state matches the cookie this server set**, compared in constant
 *    time. Without this the callback is a login-CSRF endpoint - see the long
 *    note in `SocialRedirectAction`.
 *
 * The state cookie is cleared on every exit, success or not. Left behind, it
 * is a ten-minute window in which a captured code can be replayed.
 *
 * A session cookie is set the same way `LoginAction` sets it, through the same
 * helpers, so a social sign-in and a password sign-in produce one kind of
 * session rather than two that drift. In particular the cookie's lifetime is
 * the token's, so neither outlives the other.
 */
export default new Action({
  name: 'SocialCallback',
  description: 'Complete a social sign-in and leave the browser signed in',
  method: 'GET',

  validations: {
    // All three are the provider's, not ours, and all three are checked in
    // `handle` before anything is exchanged. Declared so the reference says
    // what a callback carries rather than leaving it to be read off the code.
    code: { rule: schema.string() },
    state: { rule: schema.string() },
    error: { rule: schema.string() },
  },

  async handle(request: any) {
    const url = new URL(request.url)
    const name = url.pathname.split('/').filter(Boolean)[1] ?? ''
    const secure = isSecureRequest(request)
    const forget = clearedCookie(STATE_COOKIE, secure)

    const fail = (message: string) => new Response(null, {
      status: 303,
      headers: {
        'Location': `/login?error=${encodeURIComponent(message)}`,
        'Set-Cookie': forget,
        'Cache-Control': 'no-store',
      },
    })

    const provider = providerFor(name)

    if (!provider)
      return response.json({ error: 'Not found' }, 404)

    // Cancelled at the provider. Nothing went wrong, so nothing is reported.
    if (url.searchParams.get('error')) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': '/login', 'Set-Cookie': forget, 'Cache-Control': 'no-store' },
      })
    }

    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''

    if (!code || !state)
      return fail('That sign-in did not complete. Please try again.')

    const stored = readStateCookie(request)

    if (!stored || !sameString(stored.state, state))
      return fail('That sign-in could not be verified. Please try again.')

    let profile: any
    try {
      const token = await provider.getAccessToken(code)
      profile = await provider.getUserByToken(token)
    }
    catch {
      // The provider refused the exchange, or answered something the driver
      // could not read. Either way the visitor cannot act on the detail, and
      // the detail often contains the code - which does not belong in a URL.
      return fail('That sign-in could not be completed. Please try again.')
    }

    if (!profile?.id)
      return fail('That provider did not identify you. Please try another method.')

    const { userId } = await provisionFromSocial(name, profile)
    const result: any = await Auth.loginUsingId(Number(userId))

    const headers = new Headers()
    headers.append('Set-Cookie', sessionCookie(await sessionCookieName(), String(result.token), {
      maxAgeSeconds: Number(result.expiresIn ?? 60 * 60 * 24 * 7),
      secure,
    }))
    headers.append('Set-Cookie', forget)
    headers.set('Location', stored.next)
    headers.set('Cache-Control', 'no-store')

    return new Response(null, { status: 303, headers })
  },
})

/**
 * The state and the return path this server set before the redirect.
 *
 * One cookie holding `state:next`, split on the first colon only - a path may
 * legitimately contain one, and a `next` truncated at `/a/b:c` would send
 * somebody somewhere they did not ask for.
 */
function readStateCookie(request: any): { state: string, next: string } | null {
  const header = String(request.headers?.get?.('cookie') ?? request.get?.('cookie') ?? '')
  const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${STATE_COOKIE}=`))

  if (!match)
    return null

  const value = decodeURIComponent(match.slice(STATE_COOKIE.length + 1))
  const split = value.indexOf(':')

  if (split <= 0)
    return null

  const next = value.slice(split + 1)

  // Re-checked on the way out, not only on the way in. The cookie is
  // `HttpOnly`, so this is defence against our own future mistakes rather than
  // against the browser, which is the kind worth keeping.
  const safe = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')

  return { state: value.slice(0, split), next: safe ? next : '/reviews' }
}

/** Constant time, so a mismatch cannot be found one character at a time. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  if (left.length !== right.length)
    return false

  return timingSafeEqual(left, right)
}
