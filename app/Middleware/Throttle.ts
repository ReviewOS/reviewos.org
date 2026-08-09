import type { Consumption, Limit, Verdict } from '../Api/rate-limit'
import { Middleware } from '@stacksjs/router'
import { bucketFor, check, DEFAULT_READ_LIMIT, DEFAULT_WRITE_LIMIT, headers } from '../Api/rate-limit'
import { prefixOf } from '../Actions/Tokens/secret'

/**
 * Rate limiting, keyed by credential rather than by address.
 *
 * Overrides the framework's `throttle`, which keys on IP or authenticated user.
 * That is the wrong unit here for the reason `app/Api/rate-limit.ts` sets out:
 * **one agent looping must not exhaust the budget of the person who issued its
 * token, or of the other three agents on the same account.** A shared bucket
 * means the first bad retry loop takes everything down with it, and the first
 * bad loop is never malice - it is a retry with no backoff.
 *
 * So the bucket is the token, falling back to the account, falling back to the
 * address. An address is the weakest of the three and deliberately last: it is
 * shared by everybody behind one NAT, so a limit keyed on it is a limit an
 * office shares. It exists to blunt an unauthenticated flood, not to be fair.
 *
 * Usage on a route: `.middleware('throttle')` for the defaults, or
 * `.middleware('throttle:30,1m')` to say otherwise - the framework's pattern
 * syntax, kept so a route reads the same as it would in any Stacks app.
 *
 * ## Why this counts in memory
 *
 * A per-request limiter protects against a burst happening *now*. Writing a row
 * per request to record that is a cost paid on every single request to save an
 * attacker's burst surviving a deploy, which is the wrong way round.
 *
 * That is a genuinely different trade from `app/Api/token-limits.ts`, which
 * counts what a token *creates* in an hour and does write a row: there the
 * write is one per created object, against an operation that already writes
 * several, and a budget that resets on deploy is no budget at all because the
 * loop it defends against outlives a deploy.
 *
 * The consequence, stated rather than hidden: with several processes behind a
 * load balancer, each holds its own counter, so the effective limit is the
 * configured one times the number of processes. That is fine for what this is
 * for - it still turns an unbounded flood into a bounded one - and an instance
 * that needs an exact global limit wants a shared store, which is a change to
 * this file and nothing else.
 */

/** One bucket's state. Reset lazily, when a request finds the window expired. */
const buckets = new Map<string, Consumption>()

/**
 * How many buckets to keep before forgetting the oldest.
 *
 * Without a cap this is a memory leak with a friendly name: every address that
 * ever made a request keeps an entry forever, and the address space is large.
 * Ten thousand is far more than any real instance has active at once, and
 * evicting the oldest costs an attacker nothing they did not already have -
 * they were going to be under the limit again after the window anyway.
 */
const MAX_BUCKETS = 10_000

export default new Middleware({
  name: 'throttle',
  // Early, so a flood is refused before anything expensive - the auth
  // middleware's password hash included.
  priority: 1,

  async handle(request: any) {
    /*
     * Once per request, whatever the chain says.
     *
     * This is registered on the whole API in `app/Routes.ts` *and* named again
     * on the routes that want a tighter number, so it runs twice on those. Two
     * runs charged two units, which quietly halved every limit it was supposed
     * to be raising - the route asking for `10,5m` got five.
     *
     * The route's own parameters win, because they run second and overwrite the
     * marker; what does not happen twice is the spending.
     */
    if (request.__throttled)
      return

    request.__throttled = true

    const limit = limitFor(request)
    const key = `${credentialOf(request)}:${limit.max}:${limit.windowMs}`

    const now = Date.now()
    const existing = buckets.get(key) ?? { used: 0, windowStartedMs: now }
    const verdict = check(limit, existing, now)

    remember(key, existing, verdict, limit, now)

    if (!verdict.allowed) {
      /*
       * Thrown rather than returned, because that is how this router
       * short-circuits a middleware. The body carries the same numbers as the
       * headers: a client on a generic HTTP layer reads one and a client
       * written against this API reads the other, and sending only one means
       * half of them busy-loop.
       */
      throw new Response(
        JSON.stringify({
          error: {
            code: 'rate_limited',
            message: 'Too many requests.',
            fix: `Wait ${verdict.retryAfterSeconds} seconds. The limit is ${limit.max} per ${Math.round(limit.windowMs / 1000)}s, per token.`,
            retryAfter: verdict.retryAfterSeconds,
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(verdict.retryAfterSeconds),
            ...headers(limit, verdict),
          },
        },
      )
    }

    /*
     * On *every* answer, not only the refusal. A client that learns its budget
     * when it runs out cannot pace itself, only recover - which is the whole
     * complaint the rate-limit module opens with.
     *
     * `_responseHeaders` is the router's seam for exactly this, added upstream
     * because the middleware pipeline is pre-action and a middleware with
     * something to say about the answer previously had nowhere to put it. The
     * alternative was wrapping every action in this application.
     */
    request._responseHeaders = { ...(request._responseHeaders ?? {}), ...headers(limit, verdict) }
  },
})

/** Record the new count, and keep the map from growing without bound. */
function remember(key: string, existing: Consumption, verdict: Verdict, limit: Limit, now: number): void {
  if (!verdict.allowed) {
    // A refused request does not extend its own lockout. Counting it would let
    // a client already being refused push the window out by retrying, which is
    // exactly what the loop this defends against does.
    return
  }

  const rolled = now - existing.windowStartedMs >= limit.windowMs

  buckets.set(key, {
    windowStartedMs: rolled ? now : existing.windowStartedMs,
    used: rolled ? 1 : existing.used + 1,
  })

  if (buckets.size > MAX_BUCKETS) {
    // Insertion order, so the oldest goes first. Cheap, and good enough: the
    // alternative is tracking access times to evict the least recently used,
    // which costs every request to improve an eviction nobody notices.
    const oldest = buckets.keys().next().value
    if (oldest !== undefined)
      buckets.delete(oldest)
  }
}

/**
 * The budget for this request.
 *
 * A route may name one (`throttle:30,1m`). Otherwise reads are generous and
 * writes are tight, because the design asks clients to poll and then makes
 * polling free with `ETag` - punishing it would be incoherent - while a
 * thousand reads are invisible and a thousand comments are somebody's
 * afternoon.
 */
function limitFor(request: any): Limit {
  const pattern = String(request?._middlewareParams?.throttle ?? '').trim()

  if (pattern) {
    const parsed = parsePattern(pattern)
    if (parsed)
      return parsed
  }

  const method = String(request?.method ?? 'GET').toUpperCase()

  return method === 'GET' || method === 'HEAD' ? DEFAULT_READ_LIMIT : DEFAULT_WRITE_LIMIT
}

/**
 * `60`, `60,1`, `10,30s`, `100,5m`, `1000,1h`.
 *
 * The framework's syntax, kept rather than invented, so a route in this app
 * reads the same as a route in any other Stacks app. A bare number is per
 * minute, which is the convention every framework with this feature uses.
 */
export function parsePattern(pattern: string): Limit | null {
  const [rawMax, rawWindow = '1'] = pattern.split(',').map(part => part.trim())

  const max = Number(rawMax)
  if (!Number.isFinite(max) || max < 0)
    return null

  const match = /^(\d+)([smh]?)$/.exec(String(rawWindow))
  if (!match)
    return null

  const amount = Number(match[1])
  const unit = match[2] || 'm'

  const windowMs = unit === 's' ? amount * 1000 : unit === 'h' ? amount * 3_600_000 : amount * 60_000

  return windowMs > 0 ? { max: Math.floor(max), windowMs } : null
}

/**
 * What to count this request against.
 *
 * Read from the `Authorization` header directly rather than from whatever the
 * auth middleware resolved, because **this runs before it** - and on the routes
 * that have no auth middleware at all, it never runs. Waiting for a resolved
 * token meant every such request fell through to the address, which is the
 * shared bucket this whole override exists to avoid: two tokens on one machine
 * counted as one.
 *
 * A token's *prefix* is the public half and identifies it uniquely, and finding
 * it is a string split. Keying on that is exactly as good as keying on the row
 * id and costs no query - which matters when the alternative is one database
 * round trip on every request, to a middleware whose job is to make requests
 * cheap to refuse.
 *
 * A bearer that is not ours is keyed by a short digest rather than by the token
 * itself, so two of them get two buckets without the secret being used as a map
 * key that something might later log.
 */
function credentialOf(request: any): string {
  const header = String(request?.headers?.get?.('authorization') ?? '')

  if (header.startsWith('Bearer ')) {
    const presented = header.slice('Bearer '.length).trim()
    const prefix = prefixOf(presented)

    if (prefix)
      return `token:${prefix}`

    if (presented)
      return `bearer:${new Bun.CryptoHasher('sha256').update(presented).digest('hex').slice(0, 32)}`
  }

  return bucketFor({
    userId: Number((request as any)._authenticatedUser?.id) || null,
    ip: addressOf(request),
  })
}

/**
 * The caller's address.
 *
 * `x-forwarded-for` first, because this runs behind a proxy in every real
 * deployment and the socket address there is the proxy's - one bucket for the
 * whole internet. The *first* entry, which is the client as the nearest trusted
 * proxy saw it; the rest of the list is whatever the client claimed and is not
 * worth reading.
 */
function addressOf(request: any): string | null {
  const forwarded = String(request?.headers?.get?.('x-forwarded-for') ?? '').split(',')[0]?.trim()

  return forwarded || String(request?.headers?.get?.('x-real-ip') ?? '').trim() || null
}

/** Everything this has counted. Exported for tests, which need a clean slate. */
export function resetBuckets(): void {
  buckets.clear()
}
