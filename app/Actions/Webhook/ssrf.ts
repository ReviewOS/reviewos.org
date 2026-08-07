/**
 * Deciding whether the server may make a request to a URL somebody typed.
 *
 * A webhook URL is attacker-controlled and the request leaves from inside the
 * network, so it is a request to reach anything the server can reach and the
 * user cannot: the metadata service on a cloud instance, an admin panel bound
 * to localhost, a database on a private subnet. The consequence is credential
 * theft, not a broken webhook.
 *
 * The rules are deliberately a deny-by-default list of address ranges rather
 * than a hostname blocklist. A hostname is whatever DNS says it is at the
 * moment of the request, and `localtest.me` resolves to 127.0.0.1 today. So the
 * check that matters is on the resolved address, and it has to run again on
 * every redirect: a URL that passes and then 302s to `http://169.254.169.254/`
 * has defeated a check that only looked at the first hop.
 *
 * Pure. The caller resolves DNS and follows redirects; everything about which
 * addresses and schemes are allowed is decided here, where it can be tested.
 */

export type BlockReason =
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'hostname'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'unique-local'

export interface UrlVerdict {
  allowed: boolean
  reason?: BlockReason
  message?: string
}

/** Only these two carry a webhook. Anything else is a way to reach a file or a service. */
export const ALLOWED_SCHEMES = ['http:', 'https:'] as const

/**
 * Ports a webhook may target.
 *
 * An empty list means every port, which is the default: an internal service on
 * an odd port is caught by its address, not its port number, and a port
 * allowlist mostly breaks legitimate endpoints behind reverse proxies.
 */
export const BLOCKED_PORTS = [22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017] as const

/**
 * Hosts the operator has vouched for, from `WEBHOOK_ALLOWED_HOSTS`.
 *
 * Empty by default, and read from the environment rather than from a webhook
 * row - the point of this file is that a webhook URL is *not* trusted, so a
 * per-webhook override would be the same as no policy at all. The environment
 * belongs to whoever runs the server, and they are the only person entitled to
 * say that `ci.internal` is a real destination rather than an attack.
 *
 * That is a real need on a self-hosted forge. A CI runner on the same LAN is
 * the ordinary case, and a policy with no way to express it is one operators
 * work around by turning the whole check off.
 *
 * Matched on the host as written, including the port when one is given, so
 * `127.0.0.1:9000` allows one service and not every port on the machine.
 */
export function allowedHosts(): string[] {
  return String(Bun.env.WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

/** Whether the operator named this host, with or without its port. */
export function isAllowedHost(hostname: string, port?: number | string | null): boolean {
  const hosts = allowedHosts()
  if (hosts.length === 0)
    return false

  const host = String(hostname).replace(/\.$/, '').toLowerCase()

  return hosts.includes(host) || (port ? hosts.includes(`${host}:${port}`) : false)
}

/** Check the URL itself, before any DNS lookup. */
export function inspectUrl(raw: string): UrlVerdict {
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    return { allowed: false, reason: 'hostname', message: 'That is not a valid URL' }
  }

  if (!(ALLOWED_SCHEMES as readonly string[]).includes(url.protocol))
    return { allowed: false, reason: 'scheme', message: 'A webhook URL must be http or https' }

  // `http://user:pass@host/` leaks a credential into a log, and some clients
  // treat the userinfo as the host.
  if (url.username || url.password)
    return { allowed: false, reason: 'credentials', message: 'A webhook URL cannot carry credentials' }

  if (!url.hostname)
    return { allowed: false, reason: 'hostname', message: 'A webhook URL needs a host' }

  // A trailing dot is the same host to DNS and a different string to a
  // blocklist, which is exactly how a blocklist is bypassed.
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)

  // The operator's own list, checked before the blocks rather than after: it
  // exists precisely to name things the blocks would otherwise refuse, and a
  // list consulted afterwards could only ever allow what was allowed anyway.
  // The port is part of the match, so naming one service does not open every
  // port on that machine.
  if (isAllowedHost(hostname, url.port || port))
    return { allowed: true }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
    return { allowed: false, reason: 'loopback', message: 'That host is on this machine' }

  if ((BLOCKED_PORTS as readonly number[]).includes(port))
    return { allowed: false, reason: 'port', message: `Port ${port} is not a webhook endpoint` }

  // A bare address in the URL is checked here too, so an obvious attempt is
  // refused without waiting for a lookup.
  if (isIpAddress(hostname)) {
    const verdict = inspectAddress(hostname)
    if (!verdict.allowed)
      return verdict
  }

  return { allowed: true }
}

/**
 * Check an address DNS returned.
 *
 * This is the check that actually protects anything: the hostname above can be
 * anything at all, and only the address says where the packet goes.
 */
export function inspectAddress(address: string, port?: number | string | null): UrlVerdict {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '')

  // The operator named this address, so the ranges below do not apply to it.
  // Checked here as well as in the URL because the caller resolves the hostname
  // and re-checks what DNS returned: an allowance covering only the name would
  // refuse the very address it was written to permit, and a self-hosted
  // operator would conclude the setting does nothing.
  if (isAllowedHost(normalized, port))
    return { allowed: true }

  if (normalized.includes(':'))
    return inspectIpv6(normalized)

  return inspectIpv4(normalized)
}

function inspectIpv4(address: string): UrlVerdict {
  const parts = address.split('.')
  if (parts.length !== 4)
    return { allowed: false, reason: 'hostname', message: 'That is not an address we can check' }

  const octets = parts.map(Number)
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255))
    return { allowed: false, reason: 'hostname', message: 'That is not an address we can check' }

  const [a, b] = octets as [number, number, number, number]

  if (a === 0)
    return { allowed: false, reason: 'unspecified', message: 'That address is not routable' }

  if (a === 127)
    return { allowed: false, reason: 'loopback', message: 'That address is on this machine' }

  // 169.254.0.0/16 covers the cloud metadata service at 169.254.169.254, which
  // hands out instance credentials to anything that asks.
  if (a === 169 && b === 254)
    return { allowed: false, reason: 'link-local', message: 'That address is link local' }

  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    return { allowed: false, reason: 'private', message: 'That address is on a private network' }

  // Carrier-grade NAT and the benchmarking range are not somewhere a webhook
  // endpoint lives, and both are reachable from inside some networks.
  if (a === 100 && b >= 64 && b <= 127)
    return { allowed: false, reason: 'private', message: 'That address is on a private network' }

  if (a === 192 && b === 0)
    return { allowed: false, reason: 'reserved', message: 'That address is reserved' }

  if (a === 198 && (b === 18 || b === 19))
    return { allowed: false, reason: 'reserved', message: 'That address is reserved' }

  if (a >= 224 && a <= 239)
    return { allowed: false, reason: 'multicast', message: 'That address is multicast' }

  if (a >= 240)
    return { allowed: false, reason: 'reserved', message: 'That address is reserved' }

  return { allowed: true }
}

function inspectIpv6(address: string): UrlVerdict {
  const value = address.split('%')[0]!

  if (value === '::' || value === '::0')
    return { allowed: false, reason: 'unspecified', message: 'That address is not routable' }

  if (value === '::1')
    return { allowed: false, reason: 'loopback', message: 'That address is on this machine' }

  // An IPv4-mapped address is an IPv4 address wearing a hat, and skipping the
  // v4 rules here is how ::ffff:127.0.0.1 reaches localhost.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped)
    return inspectIpv4(mapped[1]!)

  const groups = value.split(':')
  const first = groups[0] ?? ''

  // fe80::/10
  if (/^fe[89ab]/i.test(first))
    return { allowed: false, reason: 'link-local', message: 'That address is link local' }

  // fc00::/7, the unique local range, which is the IPv6 private network.
  if (/^f[cd]/i.test(first))
    return { allowed: false, reason: 'unique-local', message: 'That address is on a private network' }

  if (/^ff/i.test(first))
    return { allowed: false, reason: 'multicast', message: 'That address is multicast' }

  return { allowed: true }
}

/** Whether a hostname is written as a literal address rather than a name. */
export function isIpAddress(hostname: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname))
    return true

  return hostname.includes(':')
}

/**
 * Whether a redirect may be followed.
 *
 * Both the target URL and the address it resolved to are re-checked, because a
 * redirect is a second request the user never named and the first check said
 * nothing about it.
 */
export function mayFollowRedirect(location: string, resolvedAddress: string | null): UrlVerdict {
  const url = inspectUrl(location)
  if (!url.allowed)
    return url

  if (resolvedAddress === null)
    return { allowed: false, reason: 'hostname', message: 'That host did not resolve' }

  return inspectAddress(resolvedAddress)
}
