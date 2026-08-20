/**
 * Where a job may connect, and where it may never.
 *
 * The section of [the execution plane](../../../docs/ci-execution-plane.md) that
 * decides whether the rest of it matters. A sandbox with unrestricted access to
 * instance-local services is not isolated: a job that can reach the control
 * plane's database has escaped without needing to escape anything.
 *
 * Pure, and written before a packet has been filtered, for the reason
 * `repairPolicy.ts` was written before the agent - a policy written afterwards
 * is a policy written against whatever the first VM already did.
 *
 * ## Two kinds of rule, and the difference is the point
 *
 * **Default-deny with an allowlist** is the ordinary half. An operator names the
 * registries their builds need and gets nothing else. Genuinely usable for a
 * great many workflows, genuinely unusable for the ones that install
 * dependencies, and the documentation must not pretend the default is free.
 *
 * **Some destinations are not allowlistable at all**, and that is the half worth
 * encoding rather than documenting. An operator writing an allowlist is thinking
 * about registries. They are not thinking about `169.254.169.254`, which hands
 * out the machine's cloud credentials to anything that asks, and which no
 * workflow has ever legitimately needed. A rule naming one of those is
 * **refused** when the policy is built rather than dropped quietly, because an
 * allowlist that silently discards the entry somebody wrote is an allowlist that
 * lies about what it permits.
 *
 * ## Names are the host's job
 *
 * A hostname allowlist enforced on addresses has a rebinding hole in it: the
 * guest resolves the name itself, gets whatever answer it likes, and connects
 * wherever it wants. So a name is only ever resolved by the host, and
 * `permitsAddress` is what the answer is then checked against - which is why
 * this file refuses a forbidden address even when it arrived as the resolution
 * of an allowlisted name.
 */

/** One destination a job is allowed to reach. */
export interface EgressRule {
  /** A hostname, or an address, or a CIDR block. */
  host: string
  /** The ports this rule opens. Empty means 443 only, which is the safe reading. */
  ports?: readonly number[]
}

export interface EgressPolicy {
  /** `deny` is the default and the safe answer for an operator who wrote nothing. */
  mode: 'deny' | 'allowlist'
  rules: readonly EgressRule[]
  /** Whether the operator deliberately opened their own private network. */
  privateAllowed: boolean
}

export interface PolicyRefusal {
  rule: string
  reason: string
}

/** The ports a rule opens when it names none. */
export const DEFAULT_PORTS = [443] as const

/**
 * Ranges no allowlist may ever name.
 *
 * Absolute, with no configuration switch, because each one is reachable only by
 * a job doing something no workflow legitimately does - and a switch is a thing
 * that gets turned on during the incident it exists for.
 */
export const NEVER_REACHABLE: readonly { cidr: string, why: string }[] = [
  { cidr: '169.254.0.0/16', why: 'the cloud metadata endpoint lives here and hands out the machine\'s credentials' },
  { cidr: '127.0.0.0/8', why: 'loopback is every service running on the runner host itself' },
  { cidr: '0.0.0.0/8', why: 'this host, by another spelling' },
  { cidr: '224.0.0.0/4', why: 'multicast reaches the operator\'s network without naming anything on it' },
  { cidr: '255.255.255.255/32', why: 'broadcast, for the same reason' },
]

/**
 * Ranges refused unless the operator opened them deliberately.
 *
 * Separate from the list above because these are somebody's ordinary network. An
 * operator whose package registry is genuinely at `10.0.0.5` is not doing
 * anything strange, and refusing them outright would be this file deciding it
 * knows their topology better than they do. What it will not do is let them
 * arrive there by accident.
 */
export const PRIVATE_RANGES: readonly { cidr: string, why: string }[] = [
  { cidr: '10.0.0.0/8', why: 'a private range - the operator\'s own network is behind it' },
  { cidr: '172.16.0.0/12', why: 'a private range - the operator\'s own network is behind it' },
  { cidr: '192.168.0.0/16', why: 'a private range - the operator\'s own network is behind it' },
  { cidr: '100.64.0.0/10', why: 'carrier-grade NAT, which on a cloud host is the provider\'s own fabric' },
]

/** Names that mean "this machine" and are refused as such. */
const LOOPBACK_NAMES = ['localhost', 'ip6-localhost', 'ip6-loopback']

/**
 * Build a policy from what an operator wrote.
 *
 * Returns the refusals rather than throwing, and returns *all* of them rather
 * than the first: somebody who wrote three bad rules should learn about three,
 * or fixing the first only earns them the second error on the next attempt.
 * That is the same shape `SubmitReviewAction` uses for inline comments.
 */
export function buildEgressPolicy(
  rules: readonly EgressRule[],
  options: { privateAllowed?: boolean, instanceAddresses?: readonly string[] } = {},
): { ok: true, policy: EgressPolicy } | { ok: false, refusals: PolicyRefusal[] } {
  const privateAllowed = options.privateAllowed === true
  const refusals: PolicyRefusal[] = []
  const accepted: EgressRule[] = []

  for (const rule of rules) {
    const host = String(rule?.host ?? '').trim()

    if (!host) {
      refusals.push({ rule: '', reason: 'a rule has to name a destination' })
      continue
    }

    const reason = refusalForDestination(host, { privateAllowed, instanceAddresses: options.instanceAddresses })

    if (reason) {
      refusals.push({ rule: host, reason })
      continue
    }

    const ports = (rule.ports ?? DEFAULT_PORTS).map(Number).filter(port => Number.isInteger(port) && port > 0 && port < 65536)

    if (ports.length === 0) {
      refusals.push({ rule: host, reason: 'no usable port was named' })
      continue
    }

    accepted.push({ host, ports })
  }

  if (refusals.length > 0)
    return { ok: false, refusals }

  return {
    ok: true,
    policy: {
      // An empty allowlist is `deny`, said plainly. The two are the same
      // behaviour and one of them is a mode somebody chose.
      mode: accepted.length === 0 ? 'deny' : 'allowlist',
      rules: accepted,
      privateAllowed,
    },
  }
}

/**
 * Why this destination may not be allowlisted, or null when it may.
 *
 * Exported because it is the rule people will argue about, and an argument
 * settled by reading a test is shorter than one settled after an incident.
 */
export function refusalForDestination(
  host: string,
  options: { privateAllowed?: boolean, instanceAddresses?: readonly string[] } = {},
): string | null {
  const cleaned = String(host ?? '').trim().toLowerCase()

  if (!cleaned)
    return 'a rule has to name a destination'

  if (LOOPBACK_NAMES.includes(cleaned) || cleaned.endsWith('.localhost'))
    return 'loopback is every service running on the runner host itself'

  for (const address of options.instanceAddresses ?? []) {
    const own = String(address ?? '').trim().toLowerCase()

    if (own && (cleaned === own || overlaps(cleaned, own)))
      return 'this is the instance itself, which a job it is running must not be able to reach'
  }

  for (const forbidden of NEVER_REACHABLE) {
    if (overlaps(cleaned, forbidden.cidr))
      return forbidden.why
  }

  if (!options.privateAllowed) {
    for (const forbidden of PRIVATE_RANGES) {
      if (overlaps(cleaned, forbidden.cidr))
        return `${forbidden.why}; set the private-network option if that is deliberate`
    }
  }

  /*
   * IPv6 gets the same treatment by prefix rather than by arithmetic. The three
   * that matter are the loopback address, unique-local, and link-local - and
   * link-local is the one that carries the metadata endpoint on providers that
   * offer it over v6.
   */
  if (cleaned === '::1' || cleaned.startsWith('::1/'))
    return 'loopback is every service running on the runner host itself'

  if (/^f[cd][0-9a-f]{2}:/.test(cleaned) && !options.privateAllowed)
    return 'a private range - the operator\'s own network is behind it; set the private-network option if that is deliberate'

  if (/^fe[89ab][0-9a-f]:/.test(cleaned))
    return 'link-local, which is where the metadata endpoint lives'

  return null
}

/**
 * Whether a policy permits an address and port.
 *
 * The address rather than the name, and that is deliberate: this is what the
 * *resolved* answer is checked against, so a name the host allowlisted that
 * resolves into a forbidden range is still refused. Rebinding is the attack, and
 * checking only the name is how it works.
 */
export function permitsAddress(
  policy: EgressPolicy,
  address: string,
  port: number,
  options: { instanceAddresses?: readonly string[] } = {},
): boolean {
  if (policy.mode === 'deny')
    return false

  // The absolute refusals apply to a resolved address exactly as they apply to
  // a written rule. This is the line that closes rebinding.
  if (refusalForDestination(address, { privateAllowed: policy.privateAllowed, instanceAddresses: options.instanceAddresses }))
    return false

  for (const rule of policy.rules) {
    if (!(rule.ports ?? DEFAULT_PORTS).includes(port))
      continue

    if (rule.host === address || contains(rule.host, address))
      return true
  }

  return false
}

/* ---------------------------------------------------------------------------
 * Addresses, as arithmetic.
 * ------------------------------------------------------------------------ */

/** An IPv4 address as a number, or null when it is not one. */
export function parseIPv4(value: string): number | null {
  const parts = String(value ?? '').trim().split('.')

  if (parts.length !== 4)
    return null

  let total = 0

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part))
      return null

    const octet = Number(part)

    if (octet > 255)
      return null

    total = (total * 256) + octet
  }

  return total >>> 0
}

/** A CIDR as its network address and mask, or null when it is not one. */
export function parseCidr(value: string): { network: number, bits: number } | null {
  const [address, suffix] = String(value ?? '').trim().split('/')
  const base = parseIPv4(address ?? '')

  if (base === null)
    return null

  // A bare address is a /32: one host, which is what somebody naming an address
  // means.
  const bits = suffix === undefined ? 32 : Number(suffix)

  if (!Number.isInteger(bits) || bits < 0 || bits > 32)
    return null

  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0

  return { network: (base & mask) >>> 0, bits }
}

/** Whether a CIDR or address contains an address. */
export function contains(cidr: string, address: string): boolean {
  const block = parseCidr(cidr)
  const target = parseIPv4(address)

  if (!block || target === null)
    return false

  const mask = block.bits === 0 ? 0 : (0xFFFFFFFF << (32 - block.bits)) >>> 0

  return ((target & mask) >>> 0) === block.network
}

/**
 * Whether two CIDRs share any address.
 *
 * The check a written rule needs, because `10.0.0.0/8` is refused not by being
 * inside a forbidden range but by *covering* one. A rule that contains the
 * metadata endpoint permits the metadata endpoint, however wide it was drawn.
 */
export function overlaps(left: string, right: string): boolean {
  const a = parseCidr(left)
  const b = parseCidr(right)

  if (!a || !b)
    return false

  // Two blocks overlap when the shorter prefix contains the other's network
  // address - there is no third case.
  const shorter = a.bits <= b.bits ? a : b
  const longer = a.bits <= b.bits ? b : a
  const mask = shorter.bits === 0 ? 0 : (0xFFFFFFFF << (32 - shorter.bits)) >>> 0

  return ((longer.network & mask) >>> 0) === shorter.network
}

/* ---------------------------------------------------------------------------
 * The policy, as packet filter rules.
 * ------------------------------------------------------------------------ */

/**
 * The nftables ruleset that enforces a policy for one guest.
 *
 * The decision above is what may be reached; this is the only thing that makes
 * it true of packets. It is a pure function for the same reason the machine spec
 * is: a ruleset is a long document where a wrong line silently permits
 * everything, and `nft` will accept an ordering that means the opposite of what
 * was intended without complaining.
 *
 * ## Order is the whole correctness argument
 *
 * 1. **The base policy is `drop`.** A rule that fails to match ends in a drop
 *    rather than an accept, so a mistake anywhere below closes the guest in
 *    rather than opening it up.
 * 2. **The absolute refusals come first**, before anything that can accept. An
 *    allowlist entry cannot reach them, which is what makes "no allowlist may
 *    name the metadata endpoint" true of packets rather than only of
 *    configuration - including when the entry arrived as a resolved address.
 * 3. **Established traffic next**, so replies to a permitted connection return
 *    without a second rule opening the reverse direction.
 * 4. **Then the allowlist**, which can only ever add to what survived step 2.
 *
 * ## Two chains, because two hooks
 *
 * A packet the host *routes onward* is seen by `forward`. A packet addressed to
 * the host **itself** is seen by `input` and never reaches `forward` at all - so
 * a forward-only ruleset leaves every service on the runner host reachable from
 * the guest, which is the exact thing "loopback is every service running on the
 * runner host itself" is about.
 *
 * That gap was found by running it. The `forward` chain was written first, the
 * rules read correctly, and a guest could still open a socket to the supervisor
 * that was meant to be containing it.
 *
 * `input` cannot take a `drop` policy - that chain governs the host's own
 * traffic, and defaulting it to drop would take the runner's SSH and its link to
 * the control plane with it. So the guest is denied by interface instead: every
 * rule is anchored to the tap, and the last one refuses the rest.
 *
 * Written as one atomic `flush`-and-define so a partially applied ruleset is not
 * a state the guest can be running in.
 */
export function nftRuleset(input: {
  /** A table name unique to this machine, so two guests cannot edit each other's. */
  table: string
  /** The guest's address, which every forwarded rule is anchored to. */
  guestAddress: string
  /** The host-side tap, which is what the input chain is anchored to. */
  tapDevice: string
  policy: EgressPolicy
  instanceAddresses?: readonly string[]
}): string {
  const guest = String(input.guestAddress ?? '').trim()
  const table = String(input.table ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'reviewos'

  const forbidden = [
    ...NEVER_REACHABLE.map(one => one.cidr),
    ...(input.policy.privateAllowed ? [] : PRIVATE_RANGES.map(one => one.cidr)),
    ...(input.instanceAddresses ?? []).map(one => String(one).trim()).filter(Boolean),
  ]

  const tap = String(input.tapDevice ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 15)

  const lines: string[] = [
    `table inet ${table} {`,
    /*
     * The host's own address space first. `policy accept`, because this chain
     * carries the runner's SSH and its link to the control plane - and the guest
     * is refused by interface rather than by making the host unreachable.
     */
    '  chain input {',
    '    type filter hook input priority 0; policy accept;',
  ]

  for (const cidr of forbidden)
    lines.push(`    iifname "${tap}" ip daddr ${cidr} drop`)

  // And the host itself, whatever address it answered on. A guest has no
  // business talking to the process supervising it.
  lines.push(`    iifname "${tap}" drop`)

  lines.push(
    '  }',
    '  chain forward {',
    // Base policy drop: a packet matching nothing is refused, so every mistake
    // below fails closed.
    '    type filter hook forward priority 0; policy drop;',
  )

  for (const cidr of forbidden)
    lines.push(`    ip saddr ${guest} ip daddr ${cidr} drop`)

  lines.push('    ct state established,related accept')

  if (input.policy.mode === 'allowlist') {
    for (const rule of input.policy.rules) {
      // Only addresses and blocks become rules. A hostname is resolved by the
      // host's resolver and enforced on the address it answered with, because a
      // name enforced as a name is a rebinding hole.
      if (parseCidr(rule.host) === null)
        continue

      for (const port of rule.ports ?? DEFAULT_PORTS)
        lines.push(`    ip saddr ${guest} ip daddr ${rule.host} tcp dport ${port} accept`)
    }
  }

  lines.push('  }', '}')

  return `flush ruleset\n${lines.join('\n')}\n`
}
