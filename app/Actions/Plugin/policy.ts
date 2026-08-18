/**
 * Who is allowed to run which plugin, decided before anything runs.
 *
 * A plugin reference is **arbitrary code selection by whoever can edit a
 * workflow file**, and it runs outside the steps - before the checkout, after
 * the artifacts, with the machine's environment rather than the job's. That is
 * a bigger thing than a step, so it gets a policy of its own.
 *
 * Three levels, and each one only ever narrows: the instance, then the
 * repository's owner, then the pool the machine is in. A level that could widen
 * what the level above allowed would make the level above decorative, which is
 * the failure mode of every allowlist that merges by union.
 */

import type { PluginReference } from './reference'

export interface PluginPolicy {
  /**
   * References this level permits. Empty means "every plugin", which reads
   * backwards until you consider which way an operator would rather be wrong:
   * an empty allowlist that meant *nothing* would turn plugins off for every
   * install that never opened this screen.
   */
  allowlist: readonly string[]
  /** Whether a reference has to name a commit or a tag rather than a branch. */
  requirePinned: boolean
  /** Capabilities permitted here. Empty means none, which is the safe way round. */
  capabilities: readonly string[]
}

export const OPEN_POLICY: PluginPolicy = { allowlist: [], requirePinned: false, capabilities: [] }

/**
 * The three levels combined.
 *
 * Allowlists intersect, `requirePinned` is true if any level asks for it, and
 * capabilities intersect - all three because narrowing is the only direction a
 * lower level may move. An empty allowlist at a level means that level has no
 * opinion, so it does not narrow.
 */
export function effectivePolicy(levels: ReadonlyArray<PluginPolicy | null | undefined>): PluginPolicy {
  let allowlist: string[] | null = null
  let capabilities: string[] | null = null
  let requirePinned = false

  for (const level of levels) {
    if (!level)
      continue

    requirePinned = requirePinned || level.requirePinned

    if (level.allowlist.length > 0) {
      allowlist = allowlist === null
        ? [...level.allowlist]
        : allowlist.filter(one => level.allowlist.includes(one))
    }

    /*
     * Capabilities are the other way round: empty means "grants none", so the
     * first level to mention any sets the ceiling and the rest narrow it. A
     * level that granted nothing and was read as "no opinion" would let a pool
     * with no configuration hand out a docker socket.
     */
    if (level.capabilities.length > 0) {
      capabilities = capabilities === null
        ? [...level.capabilities]
        : capabilities.filter(one => level.capabilities.includes(one))
    }
  }

  return {
    allowlist: allowlist ?? [],
    requirePinned,
    capabilities: capabilities ?? [],
  }
}

export type PluginVerdict = { ok: true } | { ok: false, reason: string }

/**
 * Whether this reference may run here.
 *
 * `resolvedRef` says what the ref turned out to be once somebody asked the
 * plugin's repository - a tag and a branch look identical in a workflow file,
 * and only one of them is a pin. Null means nobody has resolved it yet, which
 * is refused under a pinning policy rather than assumed to be a tag.
 */
export function pluginVerdict(input: {
  reference: PluginReference
  policy: PluginPolicy
  /** What the plugin declared it needs, from its manifest. */
  requires?: readonly string[]
  resolvedRef?: 'commit' | 'tag' | 'branch' | null
}): PluginVerdict {
  const { reference, policy } = input

  if (policy.allowlist.length > 0 && !allowed(reference, policy.allowlist))
    return { ok: false, reason: `\`${reference.raw}\` is not on this instance's plugin allowlist` }

  if (policy.requirePinned && !pinned(reference, input.resolvedRef ?? null)) {
    return {
      ok: false,
      reason: reference.ref
        ? `\`${reference.raw}\` names a branch, and this pool requires a plugin pinned to a commit or a tag`
        : `\`${reference.raw}\` has no ref, and this pool requires a plugin pinned to a commit or a tag`,
    }
  }

  const needed = input.requires ?? []
  const refused = needed.filter(one => !policy.capabilities.includes(one))

  if (refused.length > 0)
    return { ok: false, reason: `\`${reference.raw}\` requires ${refused.join(', ')}, which this pool does not grant` }

  return { ok: true }
}

/**
 * Whether the allowlist covers this reference.
 *
 * Matched on the source rather than on the whole reference, so an entry pins
 * *which plugin*, not which version of it - the version is what the pinning
 * rule is for, and an allowlist that had to be edited for every release is one
 * that gets set to `*` within a month.
 */
function allowed(reference: PluginReference, allowlist: readonly string[]): boolean {
  return allowlist.some(entry => entry === reference.source || entry === reference.raw || entry === '*')
}

/** Whether the reference names a commit or a tag rather than a moving branch. */
function pinned(reference: PluginReference, resolved: 'commit' | 'tag' | 'branch' | null): boolean {
  if (reference.pin === 'own-commit' || reference.pin === 'commit')
    return true

  if (reference.pin === 'none')
    return false

  return resolved === 'tag' || resolved === 'commit'
}
