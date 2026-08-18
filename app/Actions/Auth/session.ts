/**
 * Turning a verified identity into a signed-in browser.
 *
 * **The framework's auth actions answer with JSON and set no cookie.** That is
 * right for an API client, which reads `access_token` and sends it back as a
 * bearer - and wrong for a form, which would show a reader the raw JSON and
 * leave them signed out, because every page in this product identifies its
 * reader from the `auth-token` cookie.
 *
 * So the actions under `app/Actions/Auth/` override the defaults and end here.
 * The cookie name is read from config rather than written down, because
 * `viewerFromCookies` reads the same key from the same place and a page and the
 * endpoint its form posts to must never disagree about who is signed in.
 *
 * Pure over plain values where it can be. The cookie *string* is built by a
 * function with no request in it, so its flags can be tested without a browser -
 * and its flags are the whole security surface of a session.
 */

export interface CookieOptions {
  /** Seconds. Matches the token's own life, so neither outlives the other. */
  maxAgeSeconds: number
  /** Whether the connection is https. Set from the request, not guessed. */
  secure: boolean
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
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ]

  if (options.secure)
    parts.push('Secure')

  return parts.join('; ')
}

/** The same cookie, expired. Clearing it needs the same flags to match. */
export function clearedCookie(name: string, secure: boolean): string {
  return sessionCookie(name, '', { maxAgeSeconds: 0, secure })
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
  try {
    const { config } = await import('@stacksjs/config')

    return String(config.auth?.defaultTokenName || 'auth-token')
  }
  catch {
    return 'auth-token'
  }
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
