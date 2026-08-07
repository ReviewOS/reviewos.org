/**
 * The CSRF token, for the handful of writes this application makes from a
 * script rather than from a form.
 *
 * The router checks every non-safe method, everywhere, with a double submit: it
 * compares a value from the request against the `X-CSRF-Token` cookie, and
 * takes that value from an `x-csrf-token` header **or** from a `_token` body
 * field. `CsrfField.stx` covers the forms, which is most of the product.
 *
 * It does not cover a `fetch`. A write sent from a script with neither is
 * answered `403 CSRF token mismatch` before it reaches an action - and only for
 * a reader who is signed in, because a browser with no session has no cookie to
 * mismatch. So it passes every test written against an anonymous client, passes
 * a click-through by anybody not logged in, and fails for exactly the people
 * the feature is for.
 *
 * Kept here rather than inline so the diff viewer's comment post and its
 * progress writes cannot drift apart on it.
 */

/**
 * The token the router seeded, or an empty string.
 *
 * Both spellings, because the middleware accepts both and a proxy may
 * normalise the case of a cookie name. Never throws: a page with no cookie
 * still has to make its request, and be told no by the server rather than by
 * an exception here.
 */
export function csrfToken(): string {
  try {
    const jar = typeof document === 'undefined' ? '' : document.cookie

    for (const part of jar.split(';')) {
      const cut = part.indexOf('=')
      if (cut < 0)
        continue

      const name = part.slice(0, cut).trim()
      if (name === 'X-CSRF-Token' || name === 'x-csrf-token' || name === 'csrf-token')
        return decodeURIComponent(part.slice(cut + 1).trim())
    }
  }
  catch {
    // A document with cookies disabled. The request still goes out.
  }

  return ''
}

/** Headers for a write, with the token attached when there is one. */
export function writeHeaders(contentType = 'application/x-www-form-urlencoded'): Record<string, string> {
  const token = csrfToken()

  return token
    ? { 'Content-Type': contentType, 'x-csrf-token': token }
    : { 'Content-Type': contentType }
}
