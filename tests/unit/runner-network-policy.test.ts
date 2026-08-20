// Where a job may connect, and the places it may never be allowed to.
//
// Two of the threat model's eight adversarial gates are these: *a job cannot
// reach the database, Redis, repository storage, or loopback*, and *a job cannot
// reach the cloud metadata endpoint*. Both were scored "not met - no network
// policy exists".
//
// This is the policy's decision layer, so these tests are the rules rather than
// the packets. That distinction is stated rather than glossed: a rule that
// refuses `169.254.169.254` is not the same achievement as a booted guest
// failing to reach it, and the second belongs to phase B on a host with KVM.
// What is settled here is that the rule exists, that it cannot be written around
// by drawing a wider block, and that it still holds when a name resolves into a
// range nobody allowlisted.

import { describe, expect, test } from 'bun:test'
import {
  buildEgressPolicy,
  contains,
  overlaps,
  parseCidr,
  parseIPv4,
  permitsAddress,
  refusalForDestination,
} from '../../app/Actions/Runner/networkPolicy'

/** A policy an operator would plausibly write. */
function allowing(...hosts: string[]) {
  const built = buildEgressPolicy(hosts.map(host => ({ host, ports: [443] })))

  if (!built.ok)
    throw new Error(`expected these rules to be accepted: ${JSON.stringify(built.refusals)}`)

  return built.policy
}

describe('the default', () => {
  test('is that a job reaches nothing', () => {
    /*
     * The safe default is the one an operator gets by doing nothing, so doing
     * nothing has to mean "deny". A default of "allow" that an operator is
     * expected to narrow is a default that ships open on every instance nobody
     * configured.
     */
    const built = buildEgressPolicy([])

    expect(built.ok && built.policy.mode).toBe('deny')
    expect(permitsAddress((built as any).policy, '93.184.216.34', 443)).toBe(false)
  })

  test('and private ranges are closed until somebody opens them deliberately', () => {
    expect(refusalForDestination('10.0.0.5')).toContain('private range')
    expect(refusalForDestination('10.0.0.5', { privateAllowed: true })).toBeNull()
  })
})

describe('the destinations no allowlist may name', () => {
  test('the cloud metadata endpoint, by address', () => {
    /*
     * The one an operator writing an allowlist is not thinking about. It hands
     * out the machine's cloud credentials to anything that asks, and no workflow
     * has ever legitimately needed it.
     */
    expect(refusalForDestination('169.254.169.254')).toContain('metadata')
  })

  test('and by any block that happens to contain it', () => {
    /*
     * The rule that makes the rule worth having. `169.254.169.254` is easy to
     * refuse; the ways in are wider blocks that cover it, written by somebody
     * who was thinking about something else entirely.
     */
    for (const wide of ['169.254.0.0/16', '169.254.169.0/24', '0.0.0.0/0', '128.0.0.0/1'])
      expect(refusalForDestination(wide)).not.toBeNull()
  })

  test('loopback, by address, by block, and by name', () => {
    // Every service running on the runner host itself.
    expect(refusalForDestination('127.0.0.1')).toContain('loopback')
    expect(refusalForDestination('127.0.0.0/8')).toContain('loopback')
    expect(refusalForDestination('localhost')).toContain('loopback')
    expect(refusalForDestination('anything.localhost')).toContain('loopback')
    expect(refusalForDestination('::1')).toContain('loopback')
  })

  test('link-local over IPv6, which is where the metadata endpoint also lives', () => {
    expect(refusalForDestination('fe80::1')).toContain('link-local')
  })

  test('and the instance itself, however it is spelled', () => {
    /*
     * A job that can reach the control plane's database has escaped without
     * needing to escape anything. The instance's own addresses are passed in
     * because only the instance knows them.
     */
    const own = { instanceAddresses: ['203.0.113.10', '198.51.100.0/24'] }

    expect(refusalForDestination('203.0.113.10', own)).toContain('the instance itself')
    expect(refusalForDestination('198.51.100.7', own)).toContain('the instance itself')
    expect(refusalForDestination('198.51.100.0/25', own)).toContain('the instance itself')

    // And an unrelated address is still fine, so this is a rule rather than a
    // refusal of everything.
    expect(refusalForDestination('93.184.216.34', own)).toBeNull()
  })

  test('so a policy naming one is refused rather than quietly shortened', () => {
    /*
     * The failure this avoids: an allowlist that drops the entry somebody wrote
     * is an allowlist that lies about what it permits, and the operator finds
     * out when a build cannot reach the registry they thought they had opened -
     * or worse, never finds out.
     */
    const built = buildEgressPolicy([
      { host: 'registry.example', ports: [443] },
      { host: '169.254.169.254', ports: [80] },
      { host: '127.0.0.1', ports: [5432] },
    ])

    expect(built.ok).toBe(false)

    // All of them, not the first: somebody who wrote two bad rules should learn
    // about two.
    expect(!built.ok && built.refusals.map(one => one.rule)).toEqual(['169.254.169.254', '127.0.0.1'])
  })
})

describe('an allowlist that was accepted', () => {
  test('permits what it names, on the port it named', () => {
    const policy = allowing('93.184.216.34')

    expect(permitsAddress(policy, '93.184.216.34', 443)).toBe(true)
    expect(permitsAddress(policy, '93.184.216.34', 22)).toBe(false)
  })

  test('and a block permits the addresses inside it', () => {
    const policy = allowing('93.184.216.0/24')

    expect(permitsAddress(policy, '93.184.216.34', 443)).toBe(true)
    expect(permitsAddress(policy, '93.184.217.1', 443)).toBe(false)
  })

  test('but never a forbidden address, even reached through an allowed rule', () => {
    /*
     * Rebinding, which is the attack a hostname allowlist has built into it: the
     * guest resolves an allowlisted name, receives `169.254.169.254`, and
     * connects. Checking only the name is how that works, so the *resolved
     * address* is checked too - and this is the assertion that says so.
     */
    const policy = allowing('93.184.216.0/24')

    expect(permitsAddress(policy, '169.254.169.254', 443)).toBe(false)
    expect(permitsAddress(policy, '127.0.0.1', 443)).toBe(false)
  })

  test('and not the instance, even if a rule was written before the instance moved', () => {
    const policy = allowing('93.184.216.0/24')

    expect(permitsAddress(policy, '93.184.216.7', 443, { instanceAddresses: ['93.184.216.7'] })).toBe(false)
  })
})

describe('the address arithmetic underneath', () => {
  test('reads dotted quads, and refuses what is not one', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7F000001)
    expect(parseIPv4('255.255.255.255')).toBe(0xFFFFFFFF)
    expect(parseIPv4('256.0.0.1')).toBeNull()
    expect(parseIPv4('1.2.3')).toBeNull()
    expect(parseIPv4('example.com')).toBeNull()
  })

  test('treats a bare address as a single host', () => {
    // Which is what somebody naming an address means, and the reading that keeps
    // `contains` honest for rules written either way.
    expect(parseCidr('10.0.0.1')?.bits).toBe(32)
  })

  test('and containment is by mask rather than by string', () => {
    expect(contains('10.0.0.0/8', '10.255.255.254')).toBe(true)
    expect(contains('10.0.0.0/8', '11.0.0.1')).toBe(false)

    // The prefix trap: `10.1.1.1` starts with the same text as `10.1.1.10` and
    // is a different host.
    expect(contains('10.1.1.1', '10.1.1.10')).toBe(false)
  })

  test('and overlap is symmetric, which is what refusing a wide rule depends on', () => {
    /*
     * A rule is refused not by being *inside* a forbidden range but by covering
     * one. If this were one-directional, `0.0.0.0/0` would sail through.
     */
    expect(overlaps('0.0.0.0/0', '169.254.169.254')).toBe(true)
    expect(overlaps('169.254.169.254', '0.0.0.0/0')).toBe(true)
    expect(overlaps('10.0.0.0/8', '192.168.0.0/16')).toBe(false)
  })
})
