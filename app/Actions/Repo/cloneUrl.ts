/**
 * The URL somebody clones with.
 *
 * Derived from the request the page is answering rather than from
 * configuration, because the two disagree exactly when it matters: behind a
 * proxy, on a second domain, on a port a developer picked, or on an instance
 * whose operator never set `APP_URL`. A clone URL that is right in production
 * and wrong on the machine you are standing at is a clone URL nobody trusts.
 *
 * Configuration is the fallback, not the source. It is what a render that has
 * no request behind it - a job, a mail, a test - has to go on.
 */

/** What a request has to offer about where it arrived. Both fields are optional because both go missing. */
export interface RequestOrigin {
  /** The absolute URL of the request, when the render was given one. */
  url?: string
  /** The Host header, which carries the port and not the scheme. */
  host?: string
}

const DEFAULT_ORIGIN = 'http://localhost'

/**
 * The scheme and authority to hang a path off.
 *
 * The full URL is preferred over the Host header because it carries the scheme
 * as well, and a Host header alone cannot say whether the instance is reachable
 * over HTTPS. When only the host is known the scheme is assumed to be plain
 * HTTP, which is wrong in production and immediately visible there - unlike
 * assuming HTTPS, which produces a URL that fails to connect on every
 * development machine.
 */
export function originFor(request: RequestOrigin | null | undefined, configured?: string | null): string {
  const fromUrl = parseOrigin(request?.url)
  if (fromUrl)
    return fromUrl

  const host = (request?.host ?? '').trim()
  if (host)
    return `http://${stripTrailingSlash(host)}`

  const fromConfig = parseOrigin(configured) ?? parseOrigin(`https://${(configured ?? '').trim()}`)
  return fromConfig ?? DEFAULT_ORIGIN
}

/**
 * The clone URL for one repository.
 *
 * `.git` on the end because that is the path the wire protocol is served at,
 * and because a URL without it is a URL that browses rather than clones.
 */
export function cloneUrl(origin: string, owner: string, repository: string): string {
  return `${stripTrailingSlash(origin)}/${owner}/${repository}.git`
}

/** The whole thing, for the one caller that has a request and wants a URL. */
export function cloneUrlFor(
  request: RequestOrigin | null | undefined,
  owner: string,
  repository: string,
  configured?: string | null,
): string {
  return cloneUrl(originFor(request, configured), owner, repository)
}

function parseOrigin(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw)
    return null

  try {
    const url = new URL(raw)
    // A file or data URL parses fine and is not somewhere anyone can clone from.
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null

    return url.origin
  }
  catch {
    return null
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
