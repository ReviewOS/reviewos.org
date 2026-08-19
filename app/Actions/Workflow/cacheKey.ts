/**
 * What makes two runs' caches the same cache.
 *
 * The roadmap's requirement, and the reason this is derived rather than
 * written: *"a lockfile change invalidates it without anyone maintaining a key
 * expression"*. Every CI system that asks an author for a key gets the same
 * bug reported forever - `key: ${{ hashFiles('**\/package-lock.json') }}` with
 * the wrong glob, or the right glob and no runtime version in it, so a build
 * that moved from Bun 1.2 to 1.3 restores the old one's binaries and fails
 * somewhere unrelated to either.
 *
 * So the key is computed from the things that actually decide whether a
 * snapshot is usable:
 *
 * - **the lockfiles**, by digest, because that is what "the same dependencies"
 *   means,
 * - **the runtime**, because a native module built against one is not usable by
 *   another,
 * - **the architecture**, for the same reason and more so,
 * - **the image**, when the job runs in one, because the base decides which
 *   libc those binaries linked against.
 *
 * Anything the author *does* want to add goes in `extra`, which is where a keyed
 * `actions/cache` key lands when a migrating workflow brings one.
 */

import { createHash } from 'node:crypto'

export interface KeyInputs {
  /**
   * The lockfiles that were present, as `path -> digest`.
   *
   * A map rather than a list of digests: a repository that adds a second
   * lockfile has changed its dependencies, and a key built from digests alone
   * would be equal to the old one whenever the new file happened to be empty.
   */
  lockfiles: Record<string, string>
  /** The runtime and its version, as the job resolved it: `bun@1.3.14`. */
  runtime?: string | null
  /** `arm64`, `x64`. Not optional in practice; optional here for a caller that has not learned it yet. */
  architecture?: string | null
  /** The container image, when the job runs in one, by digest where there is one. */
  image?: string | null
  /**
   * Whatever the workflow added on purpose.
   *
   * The escape hatch that keeps this honest: an author who knows something this
   * cannot - "the cache depends on this generated file" - says so, and their
   * addition changes the key rather than being argued with.
   */
  extra?: readonly string[]
}

/**
 * The key.
 *
 * SHA-256 over a canonical rendering, which is the whole trick: the same inputs
 * in a different order must produce the same key, or a cache would miss for
 * reasons nobody can see. Lockfiles are sorted by path, `extra` is *not* sorted
 * because its order is the author's and reordering it would silently merge two
 * keys they meant to keep apart.
 */
export function snapshotKey(inputs: KeyInputs): string {
  const lockfiles = Object.entries(inputs.lockfiles ?? {})
    .map(([path, digest]) => [String(path), String(digest ?? '')] as const)
    .filter(([path]) => path.length > 0)
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)

  const canonical = JSON.stringify({
    lockfiles,
    runtime: String(inputs.runtime ?? ''),
    architecture: String(inputs.architecture ?? ''),
    image: String(inputs.image ?? ''),
    extra: (inputs.extra ?? []).map(one => String(one)),
  })

  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * The digest of one lockfile's contents.
 *
 * Contents rather than mtime or size, because a checkout gives every file the
 * time it was written and two lockfiles differing by one line are the same
 * size often enough to matter.
 */
export function lockfileDigest(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * The lockfiles worth looking for, in the order a workspace is searched.
 *
 * A fixed list rather than a glob. A glob over a checkout finds the lockfiles
 * of every vendored example and fixture in the repository, and a key that
 * changes when a test fixture does is a cache that never hits - which is
 * indistinguishable, from the outside, from caching being broken.
 */
export const LOCKFILE_NAMES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
] as const
