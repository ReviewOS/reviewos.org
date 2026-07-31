import type { ResourceSelection } from '../../TokenScopes'
import { Action } from '@stacksjs/actions'
import { normalizeGrants, resolveExpiry } from '../../TokenScopes'
import { currentUser } from '../Identity/lookup'
import { generateToken } from './secret'

const SELECTIONS = ['all', 'organization', 'selected'] as const

/**
 * Issue an access token.
 *
 * Shown once, in full, in this response and never again. The response also
 * echoes back the grants that were actually recorded rather than the ones that
 * were asked for, because unknown scopes are dropped rather than refused: a
 * client built against a newer instance still gets a working token, and can see
 * from this exactly what it got.
 */
export default new Action({
  name: 'CreateAccessToken',
  description: 'Issue a fine-grained access token',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const name = String(request.get('name') ?? '').trim()
    if (!name)
      return response.json({ error: 'A token needs a name, so it can be recognised later' }, 422)

    const selection = String(request.get('selection') ?? 'selected')
    if (!(SELECTIONS as readonly string[]).includes(selection))
      return response.json({ error: 'A selection is all, organization, or selected' }, 422)

    const requested = request.get('permissions')
    const grants = normalizeGrants(Array.isArray(requested) ? requested : [])

    if (grants.length === 0)
      return response.json({ error: 'A token with no permissions can do nothing' }, 422)

    const nowMs = Date.now()
    const requestedExpiry = request.get('expires_at')
      ? Date.parse(String(request.get('expires_at')))
      : null

    if (requestedExpiry !== null && Number.isNaN(requestedExpiry))
      return response.json({ error: 'An expiry has to be a date' }, 422)

    const expiry = resolveExpiry(requestedExpiry, nowMs)
    if (!expiry.ok)
      return response.json({ error: expiry.error }, 422)

    let organizationId: number | null = null
    if (selection === 'organization') {
      organizationId = Number(request.get('organization_id'))
      if (!Number.isInteger(organizationId) || organizationId <= 0)
        return response.json({ error: 'An organization is required for that selection' }, 422)

      // A token cannot reach an organization its owner does not belong to. The
      // per-request check would catch this later anyway; refusing at issue time
      // means nobody walks away holding a token that silently does nothing.
      const membership = await db
        .selectFrom('org_members')
        .select(['id'])
        .where('organization_id', '=', organizationId)
        .where('user_id', '=', user.id)
        .executeTakeFirst()

      if (!membership)
        return response.json({ error: 'You are not a member of that organization' }, 422)
    }

    const repositoryIds = selection === 'selected'
      ? await readableRepositories(request.get('repository_ids'), user.id)
      : []

    if (selection === 'selected' && repositoryIds.length === 0)
      return response.json({ error: 'Choose at least one repository you can reach' }, 422)

    const issued = generateToken()

    const created = await db
      .insertInto('access_tokens')
      .values({
        user_id: user.id,
        name,
        prefix: issued.prefix,
        token_hash: issued.hash,
        selection: selection as ResourceSelection,
        organization_id: organizationId,
        expires_at: new Date(expiry.expiresAtMs).toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    const tokenId = Number(created?.id)

    for (const grant of grants) {
      await db
        .insertInto('access_token_permissions')
        .values({ access_token_id: tokenId, scope: grant.scope, level: grant.level })
        .execute()
    }

    for (const repositoryId of repositoryIds) {
      await db
        .insertInto('access_token_repositories')
        .values({ access_token_id: tokenId, repository_id: repositoryId })
        .execute()
    }

    return response.json({
      id: tokenId,
      name,
      // The only time this is ever returned.
      token: issued.token,
      prefix: issued.prefix,
      selection,
      organization_id: organizationId,
      repository_ids: repositoryIds,
      permissions: grants,
      expires_at: new Date(expiry.expiresAtMs).toISOString(),
    }, 201)
  },
})

/**
 * The requested repositories, filtered to the ones this user can actually read.
 *
 * Filtered rather than refused, so a stale id in a script does not fail the
 * whole request, and reported back in the response so the caller can see what
 * the token ended up scoped to.
 */
async function readableRepositories(requested: unknown, userId: number): Promise<number[]> {
  const ids = (Array.isArray(requested) ? requested : [])
    .map(value => Number(value))
    .filter(id => Number.isInteger(id) && id > 0)

  if (ids.length === 0)
    return []

  const rows = await db
    .selectFrom('repositories')
    .select(['id', 'owner_type', 'owner_id', 'visibility'])
    .where('id', 'in', ids)
    .execute()

  const reachable: number[] = []

  for (const row of rows) {
    const id = Number(row.id)

    if (String(row.visibility) === 'public') {
      reachable.push(id)
      continue
    }

    if (String(row.owner_type) === 'user' && Number(row.owner_id) === userId) {
      reachable.push(id)
      continue
    }

    const collaborator = await db
      .selectFrom('repo_collaborators')
      .select(['id'])
      .where('repository_id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst()

    if (collaborator) {
      reachable.push(id)
      continue
    }

    if (String(row.owner_type) !== 'organization')
      continue

    const membership = await db
      .selectFrom('org_members')
      .select(['id'])
      .where('organization_id', '=', Number(row.owner_id))
      .where('user_id', '=', userId)
      .executeTakeFirst()

    if (membership)
      reachable.push(id)
  }

  return reachable
}
