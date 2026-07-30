// The SSRF guard.
//
// This is the highest-risk code in the webhook feature: the URL is supplied by
// whoever can create a webhook, and the request leaves from inside the network.
// The cases below are the ones that actually get used — the cloud metadata
// address, a hostname that resolves to loopback, an IPv4-mapped IPv6 address,
// and a redirect that only turns hostile on the second hop.

import { describe, expect, test } from 'bun:test'
import { inspectAddress, inspectUrl, isIpAddress, mayFollowRedirect } from '../../app/Actions/Webhook/ssrf'

describe('inspectUrl', () => {
  test('allows an ordinary https endpoint', () => {
    expect(inspectUrl('https://example.com/hooks/reviewos').allowed).toBe(true)
  })

  test('allows http, which plenty of internal-to-external endpoints still use', () => {
    expect(inspectUrl('http://example.com/hook').allowed).toBe(true)
  })

  test('refuses a scheme that is not http', () => {
    expect(inspectUrl('file:///etc/passwd').reason).toBe('scheme')
    expect(inspectUrl('gopher://example.com/').reason).toBe('scheme')
    expect(inspectUrl('ftp://example.com/').reason).toBe('scheme')
  })

  test('refuses credentials in the URL', () => {
    expect(inspectUrl('https://user:secret@example.com/hook').reason).toBe('credentials')
  })

  test('refuses localhost by name', () => {
    expect(inspectUrl('http://localhost:8080/hook').reason).toBe('loopback')
    expect(inspectUrl('http://api.localhost/hook').reason).toBe('loopback')
    expect(inspectUrl('http://printer.local/hook').reason).toBe('loopback')
  })

  test('refuses localhost written with a trailing dot', () => {
    // The same host to DNS, a different string to a naive blocklist.
    expect(inspectUrl('http://localhost./hook').reason).toBe('loopback')
  })

  test('refuses a literal loopback address', () => {
    expect(inspectUrl('http://127.0.0.1/hook').reason).toBe('loopback')
    expect(inspectUrl('http://127.1.2.3/hook').reason).toBe('loopback')
  })

  test('refuses the cloud metadata address', () => {
    // The one that hands out instance credentials to anything that asks.
    expect(inspectUrl('http://169.254.169.254/latest/meta-data/').reason).toBe('link-local')
  })

  test('refuses private ranges', () => {
    expect(inspectUrl('http://10.0.0.5/hook').reason).toBe('private')
    expect(inspectUrl('http://172.16.4.1/hook').reason).toBe('private')
    expect(inspectUrl('http://172.31.255.255/hook').reason).toBe('private')
    expect(inspectUrl('http://192.168.1.1/hook').reason).toBe('private')
  })

  test('allows the public addresses adjacent to those ranges', () => {
    // 172.15 and 172.32 are public; only 172.16 to 172.31 are not.
    expect(inspectUrl('http://172.15.0.1/hook').allowed).toBe(true)
    expect(inspectUrl('http://172.32.0.1/hook').allowed).toBe(true)
    expect(inspectUrl('http://11.0.0.1/hook').allowed).toBe(true)
  })

  test('refuses a port that belongs to a service, not a webhook', () => {
    expect(inspectUrl('http://example.com:22/hook').reason).toBe('port')
    expect(inspectUrl('http://example.com:6379/hook').reason).toBe('port')
    expect(inspectUrl('http://example.com:5432/hook').reason).toBe('port')
  })

  test('allows ordinary web ports', () => {
    expect(inspectUrl('https://example.com:8443/hook').allowed).toBe(true)
    expect(inspectUrl('http://example.com:3000/hook').allowed).toBe(true)
  })

  test('refuses something that is not a URL at all', () => {
    expect(inspectUrl('not a url').allowed).toBe(false)
    expect(inspectUrl('').allowed).toBe(false)
  })

  test('allows a hostname that merely looks alarming', () => {
    // The name is not the check; the resolved address is.
    expect(inspectUrl('https://localhost.example.com/hook').allowed).toBe(true)
  })
})

describe('inspectAddress', () => {
  test('allows a public address', () => {
    expect(inspectAddress('93.184.216.34').allowed).toBe(true)
  })

  test('refuses loopback, private, and link-local', () => {
    expect(inspectAddress('127.0.0.1').reason).toBe('loopback')
    expect(inspectAddress('10.1.2.3').reason).toBe('private')
    expect(inspectAddress('169.254.169.254').reason).toBe('link-local')
  })

  test('refuses 0.0.0.0, which reaches every local interface', () => {
    expect(inspectAddress('0.0.0.0').reason).toBe('unspecified')
  })

  test('refuses carrier-grade NAT', () => {
    expect(inspectAddress('100.64.0.1').reason).toBe('private')
    expect(inspectAddress('100.127.255.255').reason).toBe('private')
  })

  test('allows the public addresses either side of that range', () => {
    expect(inspectAddress('100.63.255.255').allowed).toBe(true)
    expect(inspectAddress('100.128.0.1').allowed).toBe(true)
  })

  test('refuses multicast and reserved space', () => {
    expect(inspectAddress('224.0.0.1').reason).toBe('multicast')
    expect(inspectAddress('255.255.255.255').reason).toBe('reserved')
    expect(inspectAddress('198.18.0.1').reason).toBe('reserved')
  })

  test('refuses IPv6 loopback and unspecified', () => {
    expect(inspectAddress('::1').reason).toBe('loopback')
    expect(inspectAddress('::').reason).toBe('unspecified')
  })

  test('refuses an IPv4-mapped loopback, which is the classic bypass', () => {
    expect(inspectAddress('::ffff:127.0.0.1').reason).toBe('loopback')
    expect(inspectAddress('::ffff:169.254.169.254').reason).toBe('link-local')
  })

  test('refuses IPv6 link-local and unique-local', () => {
    expect(inspectAddress('fe80::1').reason).toBe('link-local')
    expect(inspectAddress('fd00::1').reason).toBe('unique-local')
    expect(inspectAddress('fc00::1').reason).toBe('unique-local')
  })

  test('refuses an IPv6 zone-qualified link-local', () => {
    expect(inspectAddress('fe80::1%en0').reason).toBe('link-local')
  })

  test('allows a public IPv6 address', () => {
    expect(inspectAddress('2606:2800:220:1:248:1893:25c8:1946').allowed).toBe(true)
  })

  test('strips the brackets a URL host carries', () => {
    expect(inspectAddress('[::1]').reason).toBe('loopback')
  })

  test('refuses something that is not an address', () => {
    expect(inspectAddress('example.com').allowed).toBe(false)
    expect(inspectAddress('999.1.1.1').allowed).toBe(false)
  })
})

describe('isIpAddress', () => {
  test('recognises v4 and v6 literals', () => {
    expect(isIpAddress('192.168.1.1')).toBe(true)
    expect(isIpAddress('::1')).toBe(true)
  })

  test('a name is not an address', () => {
    expect(isIpAddress('example.com')).toBe(false)
  })
})

describe('mayFollowRedirect', () => {
  test('allows a redirect to another public endpoint', () => {
    expect(mayFollowRedirect('https://other.example.com/hook', '93.184.216.34').allowed).toBe(true)
  })

  test('refuses a redirect to the metadata service', () => {
    // The whole reason redirects are re-checked: the first hop was innocent.
    expect(mayFollowRedirect('http://169.254.169.254/', '169.254.169.254').reason).toBe('link-local')
  })

  test('refuses a public-looking host that resolves somewhere private', () => {
    expect(mayFollowRedirect('https://sneaky.example.com/', '127.0.0.1').reason).toBe('loopback')
  })

  test('refuses a redirect to a scheme change', () => {
    expect(mayFollowRedirect('file:///etc/passwd', null).reason).toBe('scheme')
  })

  test('refuses when the host did not resolve', () => {
    expect(mayFollowRedirect('https://example.com/', null).allowed).toBe(false)
  })
})
