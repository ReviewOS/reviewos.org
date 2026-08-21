/**
 * Turning a request into a site.
 *
 * Two ways in, and they are checked in this order:
 *
 * 1. **The instance's Pages suffix.** `owner.pages.example.com/repo/...` names
 *    an owner in the subdomain and a repository in the first path segment.
 * 2. **A site's own domain.** Anything else is looked up as a custom domain.
 *
 * The suffix is checked first because it cannot be claimed: a site whose
 * `domain` was set to `evil.pages.example.com` must not be able to answer for
 * the owner `evil`. Matching the suffix before the table means the instance's
 * own namespace always wins.
 */

import pages from '../../../config/pages'

export interface PagesRequest {
  /** The owner handle from the subdomain, when the suffix matched. */
  owner?: string
  /** The repository name from the first path segment, when the suffix matched. */
  repository?: string
  /** The remaining path inside the site. */
  path: string
  /** The full host, for the custom-domain lookup. */
  host: string
  /** Which door this came in by. */
  kind: 'suffix' | 'domain'
}

/**
 * The `Host` header, without its port and lowercased.
 *
 * The colon is not always a port separator, which is the whole difficulty. A
 * bracketed IPv6 literal is unwrapped and left alone; a bare one - `::1`, which
 * is what a local request over IPv6 arrives as - has colons of its own, and
 * stripping a trailing `:1` from it would turn the loopback address into a
 * single colon and every comparison below into a mismatch.
 */
export function normalizeHost(host: string | null | undefined): string {
  const value = String(host ?? '').trim().toLowerCase()

  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed)
    return bracketed[1]!

  // One colon is a port. Two or more is an unbracketed IPv6 address, which has
  // no port to remove.
  return value.split(':').length === 2 ? value.replace(/:\d+$/, '') : value
}

/**
 * Whether Pages is configured at all.
 *
 * An instance with no `PAGES_DOMAIN` serves no site by any route, custom
 * domains included. That is not an oversight in the check: the suffix is the
 * feature's security boundary (see `config/pages.ts`), and an instance that
 * never established one has no boundary for a custom domain to sit inside
 * either.
 */
export function pagesEnabled(): boolean {
  return pages.domain.length > 0
}

/**
 * Read the owner, repository and path out of a Pages request.
 *
 * Returns null when the host is the bare suffix with no owner - `pages.example.com`
 * itself belongs to nobody, and answering it with some repository's site would
 * be a lottery.
 */
export function parsePagesRequest(host: string, pathname: string): PagesRequest | null {
  const normalized = normalizeHost(host)
  if (!normalized)
    return null

  if (pages.domain && normalized.endsWith(`.${pages.domain}`)) {
    const owner = normalized.slice(0, -(pages.domain.length + 1))

    // A single label. `a.b.pages.example.com` is not an owner called `a.b`, it
    // is a name nobody registered, and reading it as one would let a wildcard
    // certificate holder invent hosts that resolve to real owners' sites.
    if (!owner || owner.includes('.'))
      return null

    // The first path segment is the repository; everything after it, trailing
    // slash and all, is the path inside the site. Sliced off the string rather
    // than rebuilt from segments, so `/repo/guide/` stays `/guide/` - the slash
    // is what tells the resolver it is a directory.
    const rest = pathname.replace(/^\/+/, '')
    const slash = rest.indexOf('/')
    const repository = slash === -1 ? rest : rest.slice(0, slash)

    if (!repository)
      return null

    return {
      owner,
      repository,
      path: slash === -1 ? '/' : rest.slice(slash),
      host: normalized,
      kind: 'suffix',
    }
  }

  // The bare suffix, or the instance's own host: not a site.
  if (!pages.domain || normalized === pages.domain)
    return null

  if (!pages.customDomains)
    return null

  return { path: pathname, host: normalized, kind: 'domain' }
}
