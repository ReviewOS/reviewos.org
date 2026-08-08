import { createHash } from 'node:crypto'

/**
 * Idempotency keys, so a retry does not create the thing twice.
 *
 * **The current behaviour of every forge is to create the comment twice**, and
 * it is not a rare edge: an agent posts a review comment, the connection times
 * out after the row was written but before the response arrived, and the agent
 * does the only sensible thing and retries. There is no way for it to tell that
 * from a request that never landed.
 *
 * A person hits this too and shrugs, because they can see the duplicate and
 * delete it. An agent cannot see anything, retries with backoff, and leaves
 * four identical comments on somebody's pull request.
 *
 * The contract is the one Stripe established and clients already implement:
 * send `Idempotency-Key` with a create, and a replay of the same key returns
 * the *original* response rather than making a second thing.
 */

/** How long a key is honoured. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A key is scoped, not global.
 *
 * Scoped to the token and the endpoint, because a key is chosen by the client
 * and two clients will eventually choose the same one - a UUID from a library
 * with a bad seed, or the literal string `1`. Without scoping, one agent's
 * retry could return another agent's response, on another repository, which is
 * a disclosure rather than a duplicate.
 */
export function scopeKey(input: { tokenId: number | null, userId: number | null, route: string, key: string }): string {
  const owner = input.tokenId ? `token:${input.tokenId}` : `user:${input.userId ?? 0}`

  return `${owner}|${input.route}|${input.key}`
}

/**
 * A fingerprint of the request body.
 *
 * Stored beside the key so a *different* request reusing a key is caught. A
 * client that recycles keys across different comments would otherwise get the
 * first comment's response back for the second comment, and never learn that
 * the second one was never created - which is worse than the duplicate this
 * feature exists to prevent, because it is silent.
 */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('base64url').slice(0, 32)
}

/**
 * JSON with object keys in a fixed order.
 *
 * `JSON.stringify` preserves insertion order, so the same request serialized by
 * two client libraries can differ by key order alone - and a fingerprint that
 * changes with key order would report a conflict on an honest retry.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'

  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export type IdempotencyOutcome
  = | { kind: 'fresh' }
    | { kind: 'replay', status: number, body: string }
    | { kind: 'conflict', message: string }
    | { kind: 'in-flight', message: string }

/** A stored attempt, as far as this cares. */
export interface StoredAttempt {
  fingerprint: string
  /** Null while the first request is still running. */
  status: number | null
  body: string | null
  createdAt: number
}

/**
 * What to do with a request carrying a key.
 *
 * Four answers, and the two unhappy ones matter as much as the replay:
 *
 * - **`conflict`** - same key, different body. The client is recycling keys,
 *   and returning the first response would silently drop the second request.
 *   A 422 that says so is the only outcome that lets them find the bug.
 * - **`in-flight`** - same key, first request still running. Two retries racing
 *   is exactly what a timeout produces, and both being allowed through is the
 *   duplicate this prevents. A 409 tells the second to wait.
 */
export function decideIdempotency(
  stored: StoredAttempt | null,
  incoming: { fingerprint: string },
  nowMs: number = Date.now(),
): IdempotencyOutcome {
  if (!stored)
    return { kind: 'fresh' }

  // Expired keys are reusable. A key held forever would mean an agent that
  // derives its key from the content - a reasonable thing to do - could never
  // post the same comment twice legitimately.
  if (nowMs - stored.createdAt > IDEMPOTENCY_WINDOW_MS)
    return { kind: 'fresh' }

  if (stored.fingerprint !== incoming.fingerprint) {
    return {
      kind: 'conflict',
      message: 'That Idempotency-Key was already used with a different request body. Use a new key.',
    }
  }

  if (stored.status === null || stored.body === null) {
    return {
      kind: 'in-flight',
      message: 'A request with that Idempotency-Key is still being processed. Retry in a moment.',
    }
  }

  return { kind: 'replay', status: stored.status, body: stored.body }
}

/**
 * The header, validated.
 *
 * Length-capped and character-restricted because it becomes a database key. A
 * client sending a 4KB key is a client with a bug, and storing it is how one
 * request poisons an index.
 *
 * Returns null for absent, which the caller treats as "no idempotency" rather
 * than as an error - the header is optional, and requiring it would break every
 * client that predates it.
 */
export function readKey(raw: unknown): string | null {
  const key = String(raw ?? '').trim()

  if (!key)
    return null

  if (key.length > 255 || !/^[\w.:-]+$/.test(key))
    return null

  return key
}
