import { describe, expect, it } from 'bun:test'
import { clearedCookie, isSecureRequest, safeRedirect, sessionCookie } from '../../app/Actions/Auth/session'

/**
 * The session cookie's flags are the whole security surface of being signed in,
 * and every one of them fails silently when it is wrong: a missing `HttpOnly`
 * is invisible until an injection reads the token, and a wrongly-set `Secure`
 * is invisible except that logging in appears not to work.
 */

describe('the session cookie', () => {
  const cookie = sessionCookie('auth-token', 'abc123', { maxAgeSeconds: 3600, secure: true })

  it('is HttpOnly, because no script here needs to read it', () => {
    // The one thing that makes a stolen token useless to an injected script is
    // being unable to read it.
    expect(cookie).toContain('HttpOnly')
  })

  it('is SameSite=Lax, not Strict', () => {
    // Strict withholds the cookie on a top-level navigation from another site,
    // so following a link to a pull request from a chat message lands signed
    // out - which reads as being logged out at random. Lax sends it for that
    // and withholds it for cross-site sub-requests, which is the real threat.
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('SameSite=Strict')
  })

  it('can cross a provider form POST only when explicitly requested', () => {
    const callback = sessionCookie('oauth-state', 'state', {
      maxAgeSeconds: 600,
      secure: true,
      sameSite: 'None',
    })

    expect(callback).toContain('SameSite=None')
    expect(callback).toContain('Secure')
  })

  it('is scoped to the whole site', () => {
    expect(cookie).toContain('Path=/')
  })

  it('carries the token, encoded', () => {
    expect(sessionCookie('auth-token', 'a b+c', { maxAgeSeconds: 60, secure: false }))
      .toContain('auth-token=a%20b%2Bc')
  })

  it('expires with its token', () => {
    expect(cookie).toContain('Max-Age=3600')
  })

  it('is Secure only when the connection is', () => {
    // Setting it unconditionally means the cookie is silently dropped on a
    // plain-http self-hosted instance, and the symptom is a login form that
    // appears to work and returns you signed out.
    expect(cookie).toContain('Secure')
    expect(sessionCookie('auth-token', 'x', { maxAgeSeconds: 60, secure: false })).not.toContain('Secure')
  })

  it('clears with the same flags, or it does not clear', () => {
    const cleared = clearedCookie('auth-token', true)

    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('HttpOnly')
    expect(cleared).toContain('SameSite=Lax')
    expect(cleared).toContain('Secure')
  })
})

describe('whether the connection is https', () => {
  const request = (url: string, headers: Record<string, string> = {}) => ({
    url,
    header: (key: string) => headers[key.toLowerCase()],
  })

  it('reads the URL', () => {
    expect(isSecureRequest(request('https://forge.example/login'))).toBe(true)
    expect(isSecureRequest(request('http://forge.example/login'))).toBe(false)
  })

  it('trusts a terminating proxy, because that is the ordinary deployment', () => {
    // The request a proxy forwards is plain http. Ignoring the header drops the
    // cookie on every https instance behind one, which is most of them.
    expect(isSecureRequest(request('http://127.0.0.1:3000/login', { 'x-forwarded-proto': 'https' }))).toBe(true)
  })

  it('takes the first hop when there are several', () => {
    expect(isSecureRequest(request('http://x/login', { 'x-forwarded-proto': 'https, http' }))).toBe(true)
    expect(isSecureRequest(request('http://x/login', { 'x-forwarded-proto': 'http, https' }))).toBe(false)
  })

  it('is false rather than throwing on a request it cannot read', () => {
    expect(isSecureRequest({})).toBe(false)
    expect(isSecureRequest(request('not a url'))).toBe(false)
  })
})

describe('where a sign-in may send somebody', () => {
  it('a path on this host', () => {
    expect(safeRedirect('/acme/api/pull/12')).toBe('/acme/api/pull/12')
  })

  it('not an absolute URL', () => {
    // An open redirect on a sign-in page is the good one: somebody is sent to
    // an attacker's site in the second after typing a password, on a link that
    // genuinely started here.
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect('http://evil.example')).toBe('/')
  })

  it('not a protocol-relative one', () => {
    // The case people miss. `//evil.example` is a path by the usual test and an
    // absolute URL to a browser.
    expect(safeRedirect('//evil.example')).toBe('/')
  })

  it('not one with a backslash in it', () => {
    // A backslash is a path separator to some browsers and not to a naive
    // check, so `/\evil.example` normalises to `//evil.example`.
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect('\\\\evil.example')).toBe('/')
  })

  it('falls back to what the caller asked for', () => {
    expect(safeRedirect('', '/reviews')).toBe('/reviews')
    expect(safeRedirect(undefined, '/reviews')).toBe('/reviews')
    expect(safeRedirect('https://evil.example', '/reviews')).toBe('/reviews')
  })
})
