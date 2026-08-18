/**
 * Turning a presented token into what it may do.
 *
 * The whole point of a fine-grained token is that the answer is recomputed here
 * on every request rather than decided once when the token was issued. Two
 * things fall out of that, and both matter:
 *
 *   - Losing access to a repository revokes the token's reach into it with no
 *     separate step. Nobody has to remember to go and revoke anything.
 *   - Revoking a token stops it on the next request, not at the next cache
 *     expiry, because there is no cache.
 *
 * The cost is queries on the hot path, which is why the lookup is one indexed
 * read on the cleartext prefix rather than a scan that hashes every row.
 */

import type { TokenGrant, TokenReach } from '../../TokenScopes'
import { tokenState } from '../../TokenScopes'
import { prefixOf, tokenMatches } from './secret'

export interface AuthenticatedToken {
  tokenId: number
  userId: number
  grants: TokenGrant[]
  reach: TokenReach
  /**
   * The hourly creation budgets this token was issued with, null where it was
   * issued with none and takes the instance default.
   *
   * Carried on the authenticated token rather than fetched when a write needs
   * it. The row is already being read here, and a second query per created
   * object - to answer a question about a row this function had in its hand -
   * is the kind of cost that gets a limit removed rather than tuned.
   */
  limits: {
    pull_requests: number | null
    comments: number | null
    reviews: number | null
  }
}

export type TokenRejection = 'malformed' | 'unknown' | 'expired' | 'revoked'

export type AuthenticationResult =
  | { ok: true, token: AuthenticatedToken }
  | { ok: false, reason: TokenRejection }

/**
 * Authenticate a token string.
 *
 * The rejection reason is returned but deliberately not shown to the caller of
 * an API: "expired" and "unknown" are different facts, and telling a stranger
 * which one applies confirms that a token they found used to be real.
 */
export async function authenticateToken(
  presented: string,
  nowMs: number = Date.now(),
): Promise<AuthenticationResult> {
  // Costs a string split rather than a query, so a junk header is cheap.
  const prefix = prefixOf(presented)
  if (!prefix)
    return { ok: false, reason: 'malformed' }

  const row = await db
    .selectFrom('access_tokens')
    .select([
      'id',
      'user_id',
      'token_hash',
      'selection',
      'organization_id',
      'expires_at',
      'revoked_at',
      'limit_pull_requests_per_hour',
      'limit_comments_per_hour',
      'limit_reviews_per_hour',
    ])
    .where('prefix', '=', prefix)
    .executeTakeFirst()

  if (!row)
    return { ok: false, reason: 'unknown' }

  if (!tokenMatches(presented, String(row.token_hash)))
    return { ok: false, reason: 'unknown' }

  const state = tokenState({
    expiresAtMs: parseTime(row.expires_at),
    revokedAtMs: parseTime(row.revoked_at),
  }, nowMs)

  if (state !== 'active')
    return { ok: false, reason: state }

  const tokenId = Number(row.id)

  const permissions = await db
    .selectFrom('access_token_permissions')
    .select(['scope', 'level'])
    .where('access_token_id', '=', tokenId)
    .execute()

  const grants = permissions.map((permission: any) => ({
    scope: String(permission.scope),
    level: String(permission.level),
  })) as TokenGrant[]

  const selection = String(row.selection ?? 'selected') as TokenReach['selection']

  // Only loaded for the selection that uses it. An `all` token would otherwise
  // pay for a query whose answer it ignores.
  const repositoryIds = selection === 'selected'
    ? (await db
        .selectFrom('access_token_repositories')
        .select(['repository_id'])
        .where('access_token_id', '=', tokenId)
        .execute()).map((entry: any) => Number(entry.repository_id))
    : []

  return {
    ok: true,
    token: {
      tokenId,
      userId: Number(row.user_id),
      grants,
      reach: {
        selection,
        organizationId: row.organization_id === null ? null : Number(row.organization_id),
        repositoryIds,
      },
      limits: {
        // Null through, deliberately. Null means "the instance default", and
        // coercing it to a number here would pick one silently in the place
        // least likely to be read.
        pull_requests: hourly(row.limit_pull_requests_per_hour),
        comments: hourly(row.limit_comments_per_hour),
        reviews: hourly(row.limit_reviews_per_hour),
      },
    },
  }
}

/** An hourly budget column, as a number or null. */
function hourly(value: unknown): number | null {
  if (value === null || value === undefined)
    return null

  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

/**
 * Record that a token was used.
 *
 * Separate from authentication and never awaited on the critical path by
 * callers that cannot afford it: an unused token being visible as unused is
 * worth a write, but not worth failing a clone over if the write fails.
 */
export async function recordTokenUse(tokenId: number, ip: string | null, nowMs = Date.now()): Promise<void> {
  try {
    /*
     * The first use is an audit event; every use after it is a column.
     *
     * A token's first use is the moment it stopped being a string in somebody's
     * clipboard and started being a credential in something. That is worth a
     * permanent line - it is often the only record of *where* a token went,
     * which is the question nobody can answer later. Every subsequent use is
     * traffic, and a log with a row per clone is a log nobody reads.
     *
     * The read is conditional on the update, so the extra query only happens
     * for a token that has never been used: `last_used_at IS NULL` matches once
     * in a token's life.
     */
    const first = await db
      .selectFrom('access_tokens')
      .select(['id', 'user_id', 'prefix', 'last_used_at'])
      .where('id', '=', tokenId)
      .executeTakeFirst()

    await db
      .updateTable('access_tokens')
      .set({ last_used_at: new Date(nowMs).toISOString(), last_used_ip: ip })
      .where('id', '=', tokenId)
      .execute()

    if (first && !first.last_used_at) {
      const { recordTokenAudit } = await import('./audit')

      await recordTokenAudit({
        event: 'token:first-used',
        tokenId,
        ownerId: Number(first.user_id),
        prefix: first.prefix ? String(first.prefix) : null,
        // No actor. This is the token acting, not a person, and naming the
        // owner here would read as them having done something.
        actorId: null,
        ip,
      })
    }
  }
  catch {
    // Deliberately swallowed. See above.
  }
}

/** A stored timestamp as epoch milliseconds, or null when absent or unparseable. */
function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? null : parsed
}
