/**
 * The two primitives that make an agent cheap to serve and safe to retry.
 *
 * Both exist because of the same fact: an agent polls and an agent retries, and
 * telling it not to is advice nobody can follow. Webhooks need a public
 * endpoint and the agent on somebody's laptop has none; a timeout is
 * indistinguishable from a request that never landed.
 *
 * So the honest answers are to make polling free and to make retrying safe.
 */

import { describe, expect, it } from 'bun:test'
import { conditional, etagFrom, matchesEtag, notModified } from '../../app/Api/etag'
import {
  decideIdempotency,
  fingerprint,
  IDEMPOTENCY_WINDOW_MS,
  readKey,
  scopeKey,
  type StoredAttempt,
} from '../../app/Api/idempotency'

describe('etags', () => {
  it('is stable for the same facts and different for changed ones', () => {
    expect(etagFrom(['pr', 12, '2026-08-08T12:00:00Z'])).toBe(etagFrom(['pr', 12, '2026-08-08T12:00:00Z']))
    expect(etagFrom(['pr', 12, '2026-08-08T12:00:00Z'])).not.toBe(etagFrom(['pr', 12, '2026-08-08T12:00:01Z']))
  })

  it('distinguishes a null from an empty string, which are different facts', () => {
    // Joining without a separator would make ['a', null] and ['a'] identical,
    // so a resource losing a field would keep its tag.
    expect(etagFrom(['a', null])).not.toBe(etagFrom(['a']))
  })

  it('is weak, because the bytes genuinely are not identical', () => {
    /*
     * A strong tag promises the bytes match. They do not: the same resource
     * rendered a second later carries different relative timestamps. Weak
     * promises the *resource* is unchanged, which is the claim being made.
     */
    expect(etagFrom(['x']).startsWith('W/"')).toBe(true)
  })
})

describe('If-None-Match', () => {
  const tag = etagFrom(['pr', 12])

  it('matches the tag it was given', () => {
    expect(matchesEtag(tag, tag)).toBe(true)
  })

  it('matches inside a list, which is what a client that has seen three versions sends', () => {
    // Comparing against the whole header is the bug that makes conditional
    // requests silently never match.
    expect(matchesEtag(`W/"other", ${tag}, W/"another"`, tag)).toBe(true)
  })

  it('compares weakly, so a client that dropped the prefix still gets a 304', () => {
    const withoutPrefix = tag.replace('W/', '')

    expect(matchesEtag(withoutPrefix, tag)).toBe(true)
    expect(matchesEtag(tag, withoutPrefix)).toBe(true)
  })

  it('matches the wildcard', () => {
    expect(matchesEtag('*', tag)).toBe(true)
  })

  it('does not match a different tag, or nothing', () => {
    expect(matchesEtag('W/"different"', tag)).toBe(false)
    expect(matchesEtag('', tag)).toBe(false)
    expect(matchesEtag(null, tag)).toBe(false)
  })

  it('does not match an empty entry in a malformed list', () => {
    // `,,` would otherwise normalise to an empty string on both sides and
    // return a 304 for a client that sent nothing meaningful.
    expect(matchesEtag(',,', tag)).toBe(false)
  })
})

describe('a conditional read', () => {
  const tag = etagFrom(['pr', 12])
  const build = () => new Response(JSON.stringify({ number: 12 }), { status: 200 })

  it('returns 304 with no body when the client is current', () => {
    const answer = conditional({ headers: { get: () => tag } }, tag, build)

    expect(answer.status).toBe(304)
    expect(answer.body).toBeNull()
  })

  it('puts the tag on the 304, so the next request can still be conditional', () => {
    /*
     * A client that gets a 304 without a tag has nothing to send next time and
     * falls back to unconditional requests - the failure this exists to
     * prevent, arriving quietly one request later.
     */
    expect(notModified(tag).headers.get('etag')).toBe(tag)
  })

  it('builds the response and tags it when the client is behind', () => {
    const answer = conditional({ headers: { get: () => 'W/"stale"' } }, tag, build)

    expect(answer.status).toBe(200)
    expect(answer.headers.get('etag')).toBe(tag)
  })

  it('reads the header from either request shape', () => {
    // The framework's request exposes `header()`; a plain Request exposes
    // `headers.get`. An endpoint should not have to know which it has.
    expect(conditional({ header: () => tag }, tag, build).status).toBe(304)
  })
})

describe('idempotency keys', () => {
  const body = { path: 'src/a.ts', line: 3, body: 'this is wrong' }
  const print = fingerprint(body)

  const stored = (over: Partial<StoredAttempt> = {}): StoredAttempt => ({
    fingerprint: print,
    status: 201,
    body: '{"id":1}',
    createdAt: Date.now(),
    ...over,
  })

  it('replays the original response rather than creating a second thing', () => {
    /*
     * The whole point. An agent posts a comment, the connection times out after
     * the row was written, and it retries - which is the only sensible thing to
     * do, because a timeout is indistinguishable from a request that never
     * landed.
     */
    const outcome = decideIdempotency(stored(), { fingerprint: print })

    expect(outcome).toEqual({ kind: 'replay', status: 201, body: '{"id":1}' })
  })

  it('lets an unseen key through', () => {
    expect(decideIdempotency(null, { fingerprint: print })).toEqual({ kind: 'fresh' })
  })

  it('refuses a recycled key carrying a different body', () => {
    /*
     * Worse than the duplicate this prevents, because it is silent: returning
     * the first comment's response for a second, different comment means the
     * second was never created and the client is told it succeeded.
     */
    const outcome = decideIdempotency(stored(), { fingerprint: fingerprint({ ...body, body: 'different' }) })

    expect(outcome.kind).toBe('conflict')
  })

  it('holds a second request while the first is still running', () => {
    // Two retries racing is exactly what a timeout produces, and both being
    // allowed through is the duplicate.
    const outcome = decideIdempotency(stored({ status: null, body: null }), { fingerprint: print })

    expect(outcome.kind).toBe('in-flight')
  })

  it('lets a key be reused once its window has passed', () => {
    // Held forever, an agent deriving its key from the content - a reasonable
    // thing to do - could never legitimately post the same comment twice.
    const old = stored({ createdAt: Date.now() - IDEMPOTENCY_WINDOW_MS - 1 })

    expect(decideIdempotency(old, { fingerprint: print })).toEqual({ kind: 'fresh' })
  })
})

describe('the fingerprint', () => {
  it('ignores key order, which two client libraries will disagree about', () => {
    // A fingerprint that changed with key order would report a conflict on an
    // honest retry.
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
  })

  it('and ignores an explicitly undefined field, which JSON drops anyway', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }))
  })

  it('but notices a changed value', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })

  it('and notices order inside an array, where order is meaningful', () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]))
  })
})

describe('scoping', () => {
  it('separates two tokens using the same key', () => {
    /*
     * A key is chosen by the client and two clients will eventually choose the
     * same one - a UUID from a library with a bad seed, or the literal `1`.
     * Unscoped, one agent's retry returns another agent's response, which is a
     * disclosure rather than a duplicate.
     */
    const a = scopeKey({ tokenId: 1, userId: null, route: 'POST /comments', key: '1' })
    const b = scopeKey({ tokenId: 2, userId: null, route: 'POST /comments', key: '1' })

    expect(a).not.toBe(b)
  })

  it('and separates two endpoints', () => {
    const a = scopeKey({ tokenId: 1, userId: null, route: 'POST /comments', key: 'k' })
    const b = scopeKey({ tokenId: 1, userId: null, route: 'POST /reviews', key: 'k' })

    expect(a).not.toBe(b)
  })
})

describe('reading the header', () => {
  it('accepts an ordinary key', () => {
    expect(readKey('01JAV5-abc.def:1')).toBe('01JAV5-abc.def:1')
  })

  it('treats absence as no idempotency rather than an error', () => {
    // The header is optional; requiring it would break every client that
    // predates it.
    expect(readKey(undefined)).toBeNull()
    expect(readKey('  ')).toBeNull()
  })

  it('refuses a key too long or too strange to be a database key', () => {
    // A 4KB key is a client with a bug, and storing it is how one request
    // poisons an index.
    expect(readKey('x'.repeat(256))).toBeNull()
    expect(readKey('has spaces')).toBeNull()
    expect(readKey('drop/table')).toBeNull()
  })
})
