import { authCookie, authCookieName, authCookieToken } from '@stacksjs/auth/cookie'

/** Shared response and cookie adapters for verified sign-in actions. Browser forms
 * receive a durable framework session; API clients retain their token contract. */

export interface CookieOptions {
  /** Seconds. Matches the token's own life, so neither outlives the other. */
  maxAgeSeconds: number
  /** Whether the connection is https. Set from the request, not guessed. */
  secure: boolean
  /** Cross-site policy. Session cookies stay Lax; OAuth form callbacks need None. */
  sameSite?: 'Lax' | 'None' | 'Strict'
}

/**
 * The `Set-Cookie` value for a session.
 *
 * **`HttpOnly`** because no script in this product needs to read the token, and
 * the one thing that makes a stolen token useless to an injected script is
 * being unable to read it.
 *
 * **`SameSite=Lax`** rather than `Strict`. `Strict` withholds the cookie on a
 * top-level navigation *from another site*, so following a link to a pull
 * request from a chat message would land on it signed out - which reads as
 * being logged out at random. `Lax` sends it for that navigation and withholds
 * it for cross-site sub-requests, which is the actual threat.
 *
 * **`Secure` only when the connection is.** Setting it unconditionally means
 * the cookie is silently dropped on a plain-http self-hosted instance, and the
 * symptom is a login form that appears to work and returns you signed out.
 */
export function sessionCookie(name: string, value: string, options: CookieOptions): string {
  return authCookie(value, {
    name, path: '/', domain: '',
    maxAge: Math.max(0, Math.floor(options.maxAgeSeconds)),
    secure: options.secure, sameSite: options.sameSite ?? 'Lax',
  })
}

/** The same cookie, expired. Clearing it needs the same flags to match. */
export function clearedCookie(name: string, secure: boolean, sameSite: CookieOptions['sameSite'] = 'Lax'): string {
  return sessionCookie(name, '', { maxAgeSeconds: 0, secure, sameSite })
}

/** Whether this request arrived over https, including behind a proxy. */
export function isSecureRequest(request: RequestInstance): boolean {
  const header = (key: string): string =>
    String(request?.header?.(key) ?? request?.headers?.get?.(key) ?? '')

  // A terminating proxy is the ordinary self-hosted deployment, and the request
  // it forwards is plain http. Trusting the header is the only way to know, and
  // getting this wrong drops the cookie on every https instance behind one.
  if (header('x-forwarded-proto').split(',')[0]?.trim() === 'https')
    return true

  try {
    return new URL(String(request?.url ?? '')).protocol === 'https:'
  }
  catch {
    return false
  }
}

/** The cookie name every page and every endpoint agrees on. */
export async function sessionCookieName(): Promise<string> {
  return authCookieName()
}

/** The active credential follows the framework's bearer/cookie precedence. */
export async function currentSessionCredential(request: RequestInstance): Promise<string> {
  const { requestToken } = await import('@stacksjs/auth')
  return requestToken(request) ?? authCookieToken(request, { name: 'session_id' }) ?? ''
}

/** One browser transport shared by every completed sign-in, after verification. */
export async function signInCookies(
  request: RequestInstance,
  issued: { token: string, expiresIn?: number },
  options: { browser?: boolean } = {},
): Promise<string[]> {
  const { SessionAuth, browserSessionCookie, clearedBrowserSessionCookie, clearAuthCookie, revokeToken, startBrowserSession } = await import('@stacksjs/auth')
  const { db } = await import('@stacksjs/database')
  const { HttpError } = await import('@stacksjs/error-handling')
  const secure = isSecureRequest(request)
  const name = await sessionCookieName()
  if (options.browser ?? wantsHtml(request)) {
    const session = await startBrowserSession(issued.token)
    if (!session) throw new HttpError(401, 'Sign-in could not be completed. Please sign in again.')
    // Retire both the old host-only writer and the canonical configured scope.
    return [...new Set([browserSessionCookie(session), clearedCookie(name, secure), clearAuthCookie()])]
  }

  const previousSession = authCookieToken(request, { name: 'session_id' })
  const previousToken = authCookieToken(request)
  await db.transaction(async () => {
    if (previousSession) await SessionAuth.logout(previousSession)
    if (previousToken && previousToken !== issued.token) await revokeToken(previousToken)
  })
  return [
    sessionCookie(name, issued.token, { maxAgeSeconds: Number(issued.expiresIn ?? 60 * 60), secure }),
    ...(previousSession ? [clearedBrowserSessionCookie()] : []),
  ]
}

/** Clear every supported sign-in cookie after account-wide credential revocation. */
export async function clearedSignInCookies(request: RequestInstance): Promise<string[]> {
  const { clearAuthCookie, clearedBrowserSessionCookie } = await import('@stacksjs/auth')
  return [...new Set([clearedCookie(authCookieName(), isSecureRequest(request)), clearAuthCookie(), clearedBrowserSessionCookie()])]
}

/**
 * Whether a request came from a browser form rather than from a script.
 *
 * Decides between a redirect and JSON. One endpoint serving both is what lets
 * the page and the API stay in step - two would drift, and the one that drifts
 * is the one nobody is looking at.
 */
export function wantsHtml(request: RequestInstance): boolean {
  const accept = String(request?.header?.('accept') ?? request?.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}

/**
 * Where to go after signing in.
 *
 * **Only a path on this host.** A `next` parameter that accepts an absolute URL
 * is an open redirect, and an open redirect on a *login* endpoint is the good
 * one: an attacker sends somebody to their own site immediately after they type
 * a password, on a link that genuinely started here.
 *
 * A protocol-relative `//evil.example` is the case people miss - it is a path
 * by the usual test and an absolute URL to a browser.
 */
export function safeRedirect(raw: unknown, fallback = '/'): string {
  const value = String(raw ?? '').trim()

  if (!value.startsWith('/') || value.startsWith('//'))
    return fallback

  // A backslash is a path separator to some browsers and not to a naive check,
  // so `/\evil.example` becomes `//evil.example` after normalisation.
  if (value.includes('\\'))
    return fallback

  return value
}
