import { Action } from '@stacksjs/actions'
import { tokenState } from '../../TokenScopes'
import { currentUser } from '../Identity/lookup'
import { maskToken } from './secret'

/**
 * Every token this user holds, with what each one can actually do.
 *
 * Described in the same words as the permission checks rather than as a scope
 * string the reader has to decode. A list of tokens nobody can interpret is a
 * list nobody prunes, and an unused token that survives for two years is the
 * one that turns up in an incident.
 */
export default new Action({
  name: 'ListAccessTokens',
  description: 'List the access tokens you hold',
  method: 'GET',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const rows = await db
      .selectFrom('access_tokens')
      .select([
        'id',
        'name',
        'prefix',
        'selection',
        'organization_id',
        'expires_at',
        'last_used_at',
        'last_used_ip',
        'revoked_at',
        'created_at',
      ])
      .where('user_id', '=', user.id)
      .execute()

    const nowMs = Date.now()

    const tokens = await Promise.all(rows.map(async (row: any) => {
      const id = Number(row.id)

      const permissions = await db
        .selectFrom('access_token_permissions')
        .select(['scope', 'level'])
        .where('access_token_id', '=', id)
        .execute()

      const repositories = String(row.selection) === 'selected'
        ? (await db
            .selectFrom('access_token_repositories')
            .select(['repository_id'])
            .where('access_token_id', '=', id)
            .execute()).map((entry: any) => Number(entry.repository_id))
        : []

      const state = tokenState({
        expiresAtMs: parseTime(row.expires_at),
        revokedAtMs: parseTime(row.revoked_at),
      }, nowMs)

      return {
        id,
        name: String(row.name),
        // Enough to match against a token pasted into a CI settings page,
        // without being enough to use.
        masked: maskToken(String(row.prefix)),
        state,
        selection: String(row.selection),
        organization_id: row.organization_id === null ? null : Number(row.organization_id),
        repository_ids: repositories,
        permissions: permissions.map((permission: any) => ({
          scope: String(permission.scope),
          level: String(permission.level),
        })),
        expires_at: row.expires_at ?? null,
        // A token that has never been used says so, rather than showing a null
        // the reader has to interpret.
        last_used_at: row.last_used_at ?? null,
        last_used_ip: row.last_used_ip ?? null,
        never_used: !row.last_used_at,
        created_at: row.created_at ?? null,
      }
    }))

    return response.json({ tokens })
  },
})

function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? null : parsed
}
