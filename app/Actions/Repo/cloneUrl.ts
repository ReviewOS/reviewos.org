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

import { GIT_MOUNT } from '../Git/storage'

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
  const host = stripTrailingSlash((request?.host ?? '').trim())

  /*
   * The host the request arrived on beats the address the process is bound to.
   *
   * Behind a proxy those are different, and the bound one is useless to a
   * reader: on the deployed instance the page process sees
   * `http://localhost:3072/...` while the visitor is on `reviewos.org`, so the
   * clone box offered every visitor `http://localhost:3072/git/owner/repo.git`
   * - a URL that resolves to their own machine. Only the loopback case defers
   * to the Host header, because that is the only case where the URL is known
   * not to be the one anybody typed.
   *
   * The scheme comes from configuration when configuration is talking about
   * the same host - `APP_URL` names the public one - and is plain HTTP
   * otherwise, which is the rule this function already followed for a bare
   * Host header.
   */
  if (host && !isLoopbackHost(host) && (!fromUrl || isLoopbackHost(new URL(fromUrl).host)))
    return `${configuredSchemeFor(host, configured)}//${host}`

  /*
   * Both halves loopback, and configuration knows a public name: use it.
   *
   * This is the deployed instance exactly. The gateway rewrites `Host` to the
   * upstream it is forwarding to, so the page process sees
   * `http://localhost:3072/` in the URL *and* `localhost:3072` in the header -
   * the request carries no trace of `reviewos.org` at all. Preferring the
   * request over configuration is the right rule and it has nothing to prefer
   * here, so the clone box handed every visitor a URL pointing at their own
   * machine.
   *
   * Only when configuration names something that is not itself loopback: a
   * developer whose `APP_URL` is `reviewos.localhost` and who is reading over
   * `http://localhost:3100` should be given the port they are actually using.
   */
  const fromConfigured = parseOrigin(configured) ?? parseOrigin(`https://${(configured ?? '').trim()}`)

  if (fromConfigured && !isLoopbackHost(new URL(fromConfigured).host))
    return fromConfigured

  if (fromUrl)
    return fromUrl

  if (host)
    return `http://${host}`

  const fromConfig = parseOrigin(configured) ?? parseOrigin(`https://${(configured ?? '').trim()}`)
  return fromConfig ?? DEFAULT_ORIGIN
}

/** Loopback, in the spellings a bound server actually reports. */
function isLoopbackHost(host: string): boolean {
  const name = String(host ?? '').split(':')[0]?.toLowerCase() ?? ''

  // `.localhost` included, because RFC 6761 reserves the whole tree for the
  // loopback and this project's own development URL is `reviewos.localhost`.
  return name === 'localhost'
    || name.endsWith('.localhost')
    || name === '127.0.0.1'
    || name === '::1'
    || name === '[::1]'
    || name === '0.0.0.0'
}

/**
 * `https:` or `http:`, for a host we only know the name of.
 *
 * Configuration decides when configuration is describing this same host, which
 * is the case an operator can actually correct - `APP_URL` is `reviewos.org`
 * on the deployed instance, so its scheme is the one a visitor gets.
 *
 * Otherwise plain HTTP, for the reason the test above this states: assuming
 * HTTPS from a name alone produces a URL that fails to connect on a machine
 * serving over HTTP, while assuming HTTP in production produces one that
 * redirects. Wrong visibly beats wrong silently.
 */
function configuredSchemeFor(host: string, configured?: string | null): string {
  const origin = parseOrigin(configured) ?? parseOrigin(`https://${(configured ?? '').trim()}`)

  try {
    if (origin && new URL(origin).host.toLowerCase() === host.toLowerCase())
      return new URL(origin).protocol
  }
  catch {
    // A configured value that does not parse says nothing about the scheme.
  }

  return 'http:'
}

/**
 * The clone URL for one repository.
 *
 * `.git` on the end because that is the path the wire protocol is served at,
 * and because a URL without it is a URL that browses rather than clones.
 *
 * **`/git` in front of it**, which is not decoration. A deployed instance runs
 * the pages and the API as two processes; the page process owns `/` and hands
 * the API only what `config/server.ts` names, and a prefix is the only wildcard
 * that configuration has. Without the mount this URL was answered by the page
 * server with an HTML page, and every `git clone` of every repository on the
 * instance failed with `repository not found` - which reads as a typo or a
 * permission, and is why it went unnoticed. See `GIT_MOUNT`.
 */
export function cloneUrl(origin: string, owner: string, repository: string): string {
  return `${stripTrailingSlash(origin)}${GIT_MOUNT}/${owner}/${repository}.git`
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

/**
 * What this instance will tell people to use for SSH, if anything.
 *
 * `null` when the daemon is not running, and that is the important case. A
 * clone URL that cannot connect is worse than one fewer: somebody copies it,
 * waits for a timeout, and concludes the forge is broken rather than that a
 * feature is off. So SSH is offered only when an operator has said where it
 * answers, never inferred from the fact that the code for it exists.
 */
export interface SshEndpoint {
  host: string
  port: number
  /** The account every client connects as. The identity comes from the key. */
  user: string
}

/** The default port `buddy git:ssh` binds, mirrored from `app/Actions/Git/ssh.ts`. */
export const DEFAULT_SSH_CLONE_PORT = 2222

/**
 * Read the SSH endpoint out of the environment.
 *
 * The host falls back to the one the request arrived on, because the daemon
 * runs beside the application and an operator who has set the port has usually
 * not thought about the hostname. The port does not fall back: setting nothing
 * means the daemon is not running, and guessing 22 there would offer a URL that
 * reaches whatever sshd the machine already has - which is a much worse kind of
 * wrong than offering nothing.
 */
export function sshEndpointFrom(
  environment: { SSH_CLONE_HOST?: string, SSH_PORT?: string, SSH_CLONE_USER?: string },
  request?: RequestOrigin | null,
): SshEndpoint | null {
  const configuredHost = (environment.SSH_CLONE_HOST ?? '').trim()
  const configuredPort = (environment.SSH_PORT ?? '').trim()

  if (!configuredHost && !configuredPort)
    return null

  const host = configuredHost || hostnameOf(originFor(request)) || 'localhost'
  const port = configuredPort ? Number(configuredPort) : DEFAULT_SSH_CLONE_PORT

  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return null

  return { host, port, user: (environment.SSH_CLONE_USER ?? '').trim() || 'git' }
}

/**
 * The SSH clone URL, in whichever of the two forms git wants.
 *
 * On port 22 the scp-like form, `git@host:owner/name.git`, because that is what
 * everybody recognises and what every forge prints. On any other port the
 * `ssh://` form, because the short one has nowhere to put a port - the colon is
 * already the path separator, and `git@host:2222/owner/name.git` means the
 * repository `2222/owner/name.git`, which is a confusing way to fail.
 */
export function sshCloneUrl(endpoint: SshEndpoint, owner: string, repository: string): string {
  const path = `${owner}/${repository}.git`

  return endpoint.port === 22
    ? `${endpoint.user}@${endpoint.host}:${path}`
    : `ssh://${endpoint.user}@${endpoint.host}:${endpoint.port}/${path}`
}

/** The whole thing, for a page that has a request and wants a URL or nothing. */
export function sshCloneUrlFor(
  request: RequestOrigin | null | undefined,
  owner: string,
  repository: string,
  environment: { SSH_CLONE_HOST?: string, SSH_PORT?: string, SSH_CLONE_USER?: string },
): string | null {
  const endpoint = sshEndpointFrom(environment, request)

  return endpoint ? sshCloneUrl(endpoint, owner, repository) : null
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname
  }
  catch {
    return null
  }
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
