/**
 * What one token may create in an hour.
 *
 * The counting arithmetic is `rate-limit.ts` and is not repeated here. This is
 * the part that needs a database: which budget applies to this token, how much
 * of it is spent, and spending one.
 *
 * **Only creation is metered.** Reads go through the request-level limit, which
 * is generous on purpose because the API asks clients to poll and then makes
 * polling free with `ETag`. What a runaway loop actually costs is proportional
 * to what it creates: a thousand reads are invisible, a thousand comments are
 * somebody's afternoon.
 */

import type { AuthenticatedToken } from '../Actions/Tokens/authenticate'
import type { Limit, Verdict } from './rate-limit'
import { log } from '@stacksjs/logging'
import { authenticateToken } from '../Actions/Tokens/authenticate'
import { apiError } from './errors'
import { check } from './rate-limit'

/** The three things a token creates that somebody has to read. */
export type MeteredAction = 'pull_requests' | 'comments' | 'reviews'

export const METERED_ACTIONS: readonly MeteredAction[] = ['pull_requests', 'comments', 'reviews'] as const

const HOUR = 60 * 60 * 1000

/**
 * The instance defaults, used when a token names no limit of its own.
 *
 * Set where a person working through the interface would never reach them and a
 * loop reaches them in minutes. They are not the safety mechanism - the
 * per-token limits are - they are the floor under a token nobody configured.
 *
 * Pull requests are the tightest by an order of magnitude. Sixty comments an
 * hour is a thorough reviewer; sixty pull requests an hour is nothing anybody
 * meant to do.
 */
export const DEFAULT_LIMITS: Record<MeteredAction, Limit> = {
  pull_requests: { max: 20, windowMs: HOUR },
  comments: { max: 300, windowMs: HOUR },
  reviews: { max: 100, windowMs: HOUR },
}

/** The column a token stores its own budget in. */
const COLUMN: Record<MeteredAction, string> = {
  pull_requests: 'limit_pull_requests_per_hour',
  comments: 'limit_comments_per_hour',
  reviews: 'limit_reviews_per_hour',
}

/**
 * The budget this token has for this action.
 *
 * A null column means the instance default rather than unlimited, which is the
 * decision the model records: a column defaulting to no limit would leave every
 * token issued before the feature existed unlimited forever, and those are
 * exactly the ones running unattended.
 *
 * Zero is honoured as zero. "This token may not open pull requests" is a
 * reasonable thing for an owner to say, and treating it as unset would silently
 * do the opposite of what they asked.
 */
export function limitFor(token: { [key: string]: unknown } | null | undefined, action: MeteredAction): Limit {
  const configured = token?.[COLUMN[action]]
  const max = Number(configured)

  return configured === null || configured === undefined || !Number.isFinite(max) || max < 0
    ? DEFAULT_LIMITS[action]
    : { max: Math.floor(max), windowMs: HOUR }
}

/**
 * Spend one, and say whether it was allowed.
 *
 * Reads the window, decides, and writes the new count in one place, because a
 * caller that checks and then separately increments is a caller that will one
 * day do the work between the two and forget the increment - and an
 * unincremented limit is no limit at all.
 *
 * **Called before the object is created, and only the allowed path costs a
 * write.** A refusal leaves the row alone: a rejected attempt has not created
 * anything, and counting it would let a client that is already being refused
 * extend its own lockout indefinitely by retrying.
 *
 * Never throws. A token with no id - a browser session - is unlimited here and
 * is governed by the request-level limit instead; a database failure allows the
 * request, because refusing somebody's comment over a counter write is a worse
 * outcome than an over-count nobody will notice.
 */
export async function spend(
  tokenId: number | null | undefined,
  action: MeteredAction,
  token?: Record<string, unknown> | null,
  nowMs: number = Date.now(),
): Promise<{ verdict: Verdict, limit: Limit }> {
  const limit = limitFor(token, action)

  const unlimited: Verdict = {
    allowed: true,
    remaining: limit.max,
    resetAtSeconds: Math.ceil((nowMs + limit.windowMs) / 1000),
    retryAfterSeconds: 0,
  }

  if (!tokenId)
    return { verdict: unlimited, limit }

  try {
    const db = (globalThis as any).db

    const row: any = await db
      .selectFrom('token_usage_windows')
      .select(['id', 'window_started_at', 'used'])
      .where('access_token_id', '=', tokenId)
      .where('action', '=', action)
      .executeTakeFirst()

    const windowStartedMs = Date.parse(String(row?.window_started_at ?? '')) || 0
    const used = Number(row?.used ?? 0)

    const verdict = check(limit, { used, windowStartedMs }, nowMs)

    if (!verdict.allowed)
      return { verdict, limit }

    // A window that has run out starts fresh with this request as its first,
    // which is the same rule `check` applied to reach its verdict.
    const rolled = nowMs - windowStartedMs >= limit.windowMs
    const next = {
      window_started_at: new Date(rolled ? nowMs : windowStartedMs).toISOString(),
      used: rolled ? 1 : used + 1,
    }

    if (row?.id) {
      await db.updateTable('token_usage_windows').set(next).where('id', '=', Number(row.id)).execute()
    }
    else {
      await db
        .insertInto('token_usage_windows')
        .values({ access_token_id: tokenId, action, ...next })
        .execute()
    }

    return { verdict, limit }
  }
  catch (error) {
    /*
     * Allowed, and *logged*. Refusing somebody's comment because a counter
     * write failed trades a rare over-count for an outage, and the limit
     * exists to blunt a loop rather than to be exact.
     *
     * The log line is not decoration. A silent catch here already hid a real
     * defect once - the window column was an `integer` and epoch milliseconds
     * never fit, so every insert threw and the limit metered nothing while
     * appearing to work. A failure that allows must at least say so.
     */
    log.warn(`[token-limits] counter unavailable, allowing: ${error instanceof Error ? error.message : String(error)}`)

    return { verdict: unlimited, limit }
  }
}

/**
 * The refusal, as a response.
 *
 * Carries the same headers a successful request would, because a client that
 * only learns its budget from the rejection cannot pace itself - and
 * `Retry-After` in both the header and the body, since a client on a generic
 * HTTP layer reads one and a client written against this API reads the other.
 */
export function refusal(action: MeteredAction, limit: Limit, verdict: Verdict): Response {
  const noun = action.replace(/_/g, ' ')

  // Through `apiError`, not a second error shape. The code set is closed so a
  // client can handle it exhaustively, and an endpoint that invents its own
  // envelope for one case is the reason clients stop trusting the set.
  /*
   * `X-Create-*`, not `X-RateLimit-*`.
   *
   * Two different budgets cannot share one header name. `X-RateLimit-*` is the
   * request-rate limiter's, applied to every response by the throttle
   * middleware, and it was overwriting these - so a refusal whose body said
   * "this token may create 2 comments an hour" arrived carrying
   * `X-RateLimit-Limit: 300`. A client reading the headers and a client reading
   * the body would have disagreed about what just happened.
   */
  return apiError('rate_limited', `This token may create ${limit.max} ${noun} an hour, and has.`, {
    fix: `Wait ${verdict.retryAfterSeconds} seconds, or raise the limit on the token.`,
    retryAfter: verdict.retryAfterSeconds,
    headers: createHeaders(action, limit, verdict),
  })
}

/**
 * Spend one against whatever token this request carried.
 *
 * The shape call sites use. `spend` stays separate and takes its inputs
 * directly so the window arithmetic can be tested without a request, a router
 * or a session - which is the half most likely to be subtly wrong.
 *
 * The token row is read through `userToken()`, the router's own accessor, so
 * the limit columns come from wherever the auth middleware already put them
 * rather than from a second query per write.
 */
export async function spendFor(
  request: any,
  action: MeteredAction,
): Promise<{ verdict: Verdict, limit: Limit }> {
  const token = await tokenOn(request)

  return await spend(token?.tokenId ?? null, action, token
    ? {
        limit_pull_requests_per_hour: token.limits.pull_requests,
        limit_comments_per_hour: token.limits.comments,
        limit_reviews_per_hour: token.limits.reviews,
      }
    : null)
}

/**
 * This application's own token for a request, resolved once.
 *
 * Not `request.userToken()`. That is the framework's accessor and it reads
 * `oauth_access_tokens`, a different table from this project's `access_tokens` -
 * so it answers `undefined` for every token this forge issues, and a limit
 * built on it would silently never apply. The symptom is a feature that passes
 * every unit test and meters nothing.
 *
 * Memoized on the request, because two metered writes in one request would
 * otherwise each pay for the lookup, and the answer cannot change mid-request.
 */
async function tokenOn(request: any): Promise<AuthenticatedToken | null> {
  if (!request)
    return null

  if ('__meteredToken' in request)
    return request.__meteredToken

  let resolved: AuthenticatedToken | null = null

  try {
    const header = String(request.headers?.get?.('authorization') ?? '')

    if (header.startsWith('Bearer ')) {
      const result = await authenticateToken(header.slice('Bearer '.length).trim())
      resolved = result.ok ? result.token : null
    }
  }
  catch {
    // A browser session, or a header this does not understand. Unmetered here
    // and governed by the request-level limit instead.
  }

  try {
    request.__meteredToken = resolved
  }
  catch {
    // A frozen request object. The lookup simply happens again.
  }

  return resolved
}

/**
 * The creation budget, as headers.
 *
 * Named apart from `X-RateLimit-*` because it is a different limit measuring a
 * different thing: that one is how many requests a second, this one is how many
 * objects an hour. The action is in the header too, since a token has three
 * separate budgets and "which one did I exhaust" is the first question.
 */
export function createHeaders(action: MeteredAction, limit: Limit, verdict: Verdict): Record<string, string> {
  return {
    'X-Create-Limit': String(limit.max),
    'X-Create-Remaining': String(verdict.remaining),
    'X-Create-Reset': String(verdict.resetAtSeconds),
    'X-Create-Action': action,
  }
}
