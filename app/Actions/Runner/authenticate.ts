/**
 * Which runner is speaking.
 *
 * Its own credential, not a user's and not a repository's. A runner is a
 * machine an operator registered, and the token it holds says only "I am that
 * machine" - what it may then see is decided by its scope, in
 * [the protocol rules](./protocol.ts).
 *
 * The token is compared by hash, because that is the only form stored: a
 * registration token in the database in plain text is one in every backup.
 */

import { db } from '@stacksjs/database'
import type { RunnerFacts } from './protocol'
import { splitLabels } from './protocol'

/** SHA-256, the same way registration wrote it. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

/**
 * The bearer token on a request, or an empty string.
 *
 * Only the `Bearer` form. A token in a query string is a token in the access
 * log, in the referrer, and in somebody's shell history, and accepting it "for
 * convenience" is how it ends up there.
 */
export function bearerFrom(request: any): string {
  const header = String(request?.headers?.get?.('authorization') ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())

  return match ? String(match[1]).trim() : ''
}

export interface AuthenticatedRunner {
  facts: RunnerFacts
  /** The row, for callers that need more than the decision needs. */
  row: any
}

/**
 * Resolve the runner behind a request, or null.
 *
 * Null covers every failure - no header, unknown token, disabled runner -
 * deliberately, and the caller answers all of them the same way. Telling an
 * unauthenticated caller *which* of those it was is telling it whether a token
 * exists.
 */
export async function authenticateRunner(request: any): Promise<AuthenticatedRunner | null> {
  const token = bearerFrom(request)
  if (!token)
    return null

  const row: any = await db
    .selectFrom('runners')
    .select(['id', 'name', 'state', 'scope_type', 'scope_id', 'labels'])
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst()

  if (!row || String(row.state) !== 'active')
    return null

  // Seen, whether or not it is given work. A list of runners is a list of
  // machines somebody is paying for, and "last seen three weeks ago" is the
  // only way to notice one that quietly stopped.
  await db
    .updateTable('runners')
    .set({ last_seen_at: new Date().toISOString() })
    .where('id', '=', Number(row.id))
    .execute()

  return {
    row,
    facts: {
      id: Number(row.id),
      state: String(row.state),
      scopeType: String(row.scope_type),
      scopeId: row.scope_id === null ? null : Number(row.scope_id),
      labels: splitLabels(row.labels),
    },
  }
}
