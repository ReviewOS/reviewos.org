/**
 * One fetch of an upstream patch, shared by the requests that need it.
 *
 * The streamed viewer asks for a manifest and then asks for rows, several times,
 * as the reader scrolls. Each of those is a separate request to this server, and
 * each one needs the same patch - which for `oven-sh/bun#30412` is forty-three
 * megabytes fetched from GitHub. Fetching it again per request would be slow for
 * the reader, rude to GitHub, and would spend the outbound rate limit several
 * times over on one diff.
 *
 * So a patch is held briefly after it arrives. Briefly is the whole design:
 *
 * - **Bounded by bytes**, because these are large and this is a shared server.
 *   The oldest goes when the budget is exceeded, which is the right eviction for
 *   a cache whose entries are all being read within seconds of being written.
 * - **Bounded by time**, because a diff on GitHub changes when somebody pushes,
 *   and a viewer showing a stale patch with no way to notice is worse than one
 *   that fetches again.
 * - **Keyed by the target, not by the URL**, so the manifest and the rows agree
 *   about which diff they are describing even if their query strings differ.
 *
 * What it deliberately is *not* is a cache of somebody's private repository: an
 * entry fetched with a reader's token is keyed by that token's fingerprint, so
 * one reader's credential never serves another reader's request.
 */

import type { DiffTarget } from './parse'

interface Entry {
  patch: string
  bytes: number
  storedAt: number
}

/** How much patch text is held across all entries. */
export const MAX_CACHE_BYTES = 192 * 1024 * 1024

/** How long an entry may answer for. A push upstream is the thing this bounds. */
export const CACHE_TTL_MS = 5 * 60 * 1000

const entries = new Map<string, Entry>()
let held = 0

/**
 * A key that separates readers as well as diffs.
 *
 * The token is not stored and not recoverable from this - it is reduced to a
 * short fingerprint, which is enough to keep two readers' entries apart and not
 * enough to be a credential. An anonymous read has its own key, so the public
 * copy is shared by everybody and never serves anybody's private one.
 */
export function cacheKey(target: DiffTarget, token: string | null): string {
  const who = token ? fingerprint(token) : 'public'

  return `${who}:${target.kind}:${target.owner}/${target.repository}@${target.ref}`
}

function fingerprint(token: string): string {
  // FNV-1a. Not a security boundary - a partition key. The security boundary is
  // that the token itself is never written down anywhere.
  let hash = 0x811C9DC5

  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(36)
}

function evict(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.storedAt > CACHE_TTL_MS) {
      held -= entry.bytes
      entries.delete(key)
    }
  }

  // Insertion order is age order, so the first entry is the oldest.
  while (held > MAX_CACHE_BYTES && entries.size > 0) {
    const [key, entry] = entries.entries().next().value as [string, Entry]
    held -= entry.bytes
    entries.delete(key)
  }
}

export function cachedPatch(key: string, now: number = Date.now()): string | null {
  const entry = entries.get(key)

  if (!entry)
    return null

  if (now - entry.storedAt > CACHE_TTL_MS) {
    held -= entry.bytes
    entries.delete(key)

    return null
  }

  return entry.patch
}

export function storePatch(key: string, patch: string, now: number = Date.now()): void {
  const bytes = patch.length

  // A single patch larger than the whole budget would evict everything and then
  // itself, so it is simply not held. The request it came from still works.
  if (bytes > MAX_CACHE_BYTES)
    return

  const existing = entries.get(key)
  if (existing)
    held -= existing.bytes

  entries.set(key, { patch, bytes, storedAt: now })
  held += bytes

  evict(now)
}

/** For tests, and for an operator who wants the memory back. */
export function clearPatchCache(): void {
  entries.clear()
  held = 0
}

/** What is being held, for a status page or a test. */
export function patchCacheStats(): { entries: number, bytes: number } {
  return { entries: entries.size, bytes: held }
}
