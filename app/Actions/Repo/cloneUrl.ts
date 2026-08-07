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
