import { canInOrganization } from '../../Permissions'
import { organizationRoleOf } from '../Identity/lookup'

/**
 * Which tokens reach an organization's repositories, and who may say so.
 *
 * **The half of access tokens nobody builds**, and the one that decides whether
 * an instance is safe two years in. Every forge lets somebody see their own
 * tokens. The question an administrator actually has is the other one: what can
 * currently reach our code, and who is holding it. Without an answer, a
 * contractor leaving is a request to several people to please remember to
 * revoke something.
 *
 * A token reaches an organization in one of three ways, and all three have to
 * be asked or the list quietly under-reports - which is worse than not having
 * it, because it reads as a clean answer:
 *
 * - **`organization`** - scoped to that organization by name.
 * - **`selected`** - scoped to specific repositories, one or more of which the
 *   organization owns.
 * - **`all`** - scoped to everything its owner can reach, which includes this
 *   organization's repositories for as long as they are a member. This is the
 *   one that gets missed, because nothing joins it to the organization: the
 *   link is the owner's membership, not a row about the token.
 */

/** A token as the organization list shows it. Never the secret, in any form. */
export interface OrganizationTokenRow {
  id: number
  name: string
  /** Public, and the only way a reader tells one of somebody's tokens from another. */
  prefix: string
  ownerId: number
  ownerHandle: string
  selection: 'all' | 'organization' | 'selected'
  /** How it reaches here, which is not the same as its selection for `all`. */
  via: 'organization' | 'selected' | 'membership'
  permissions: string[]
  repositoryNames: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

/**
 * Every live token that can reach this organization's repositories.
 *
 * Revoked tokens are left out. The list is a question about present exposure,
 * and a revoked token is not exposure - it is history, and history is in the
 * audit log where it belongs.
 */
export async function tokensReaching(organizationId: number): Promise<OrganizationTokenRow[]> {
  const repositories = await db
    .selectFrom('repositories')
    .select(['id', 'name'])
    .where('owner_type', '=', 'organization')
    .where('owner_id', '=', organizationId)
    .execute()

  const repositoryNames = new Map(repositories.map(row => [Number(row.id), String(row.name)]))
  const repositoryIds = [...repositoryNames.keys()]

  // Who could hold an `all` token that reaches here. Accepted members only,
  // through the one function that knows a pending invitation is not a
  // membership.
  const memberships = await db
    .selectFrom('org_members')
    .select(['user_id', 'joined_at'])
    .where('organization_id', '=', organizationId)
    .execute()

  const memberIds = memberships.filter(row => Boolean(row.joined_at)).map(row => Number(row.user_id))

  const byId = new Map<number, { row: any, via: OrganizationTokenRow['via'] }>()

  const collect = async (rows: any[], via: OrganizationTokenRow['via']): Promise<void> => {
    for (const row of rows) {
      const id = Number(row.id)
      // First reason wins, and the order below is deliberate: an explicit scope
      // is a better explanation than "they are a member", which is the vaguest
      // of the three and the one somebody would query next.
      if (!byId.has(id))
        byId.set(id, { row, via })
    }
  }

  const live = (query: any): any =>
    query.select(['id', 'user_id', 'name', 'prefix', 'selection', 'last_used_at', 'expires_at', 'revoked_at'])
      .whereNull('revoked_at')

  await collect(
    await live(db.selectFrom('access_tokens'))
      .where('selection', '=', 'organization')
      .where('organization_id', '=', organizationId)
      .execute(),
    'organization',
  )

  if (repositoryIds.length > 0) {
    const scoped = await db
      .selectFrom('access_token_repositories')
      .select(['access_token_id'])
      .where('repository_id', 'in', repositoryIds)
      .execute()

    const scopedIds = [...new Set(scoped.map(row => Number(row.access_token_id)))]

    if (scopedIds.length > 0) {
      await collect(
        await live(db.selectFrom('access_tokens')).where('id', 'in', scopedIds).execute(),
        'selected',
      )
    }
  }

  if (memberIds.length > 0) {
    await collect(
      await live(db.selectFrom('access_tokens'))
        .where('selection', '=', 'all')
        .where('user_id', 'in', memberIds)
        .execute(),
      'membership',
    )
  }

  if (byId.size === 0)
    return []

  const tokenIds = [...byId.keys()]

  const [owners, permissions, scopedRepositories] = await Promise.all([
    db.selectFrom('users').select(['id', 'handle']).where('id', 'in', [...new Set([...byId.values()].map(entry => Number(entry.row.user_id)))]).execute(),
    db.selectFrom('access_token_permissions').select(['access_token_id', 'scope', 'level']).where('access_token_id', 'in', tokenIds).execute(),
    db.selectFrom('access_token_repositories').select(['access_token_id', 'repository_id']).where('access_token_id', 'in', tokenIds).execute(),
  ])

  const handles = new Map((owners as any[]).map(row => [Number(row.id), String(row.handle)]))

  const grantsByToken = new Map<number, string[]>()
  for (const grant of permissions as any[]) {
    const id = Number(grant.access_token_id)
    const list = grantsByToken.get(id) ?? []
    list.push(`${grant.scope}:${grant.level}`)
    grantsByToken.set(id, list)
  }

  // Only the repositories *this* organization owns. A token scoped to five
  // repositories across two organizations must not show one organization the
  // names belonging to the other.
  const reposByToken = new Map<number, string[]>()
  for (const link of scopedRepositories as any[]) {
    const name = repositoryNames.get(Number(link.repository_id))
    if (!name)
      continue

    const id = Number(link.access_token_id)
    const list = reposByToken.get(id) ?? []
    list.push(name)
    reposByToken.set(id, list)
  }

  const rows: OrganizationTokenRow[] = [...byId.values()].map(({ row, via }) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    prefix: String(row.prefix ?? ''),
    ownerId: Number(row.user_id),
    ownerHandle: handles.get(Number(row.user_id)) ?? '',
    selection: String(row.selection ?? 'selected') as OrganizationTokenRow['selection'],
    via,
    permissions: (grantsByToken.get(Number(row.id)) ?? []).sort(),
    repositoryNames: (reposByToken.get(Number(row.id)) ?? []).sort(),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  }))

  /*
   * Never used first, then least recently used.
   *
   * The reason to open this page is to find what should not be here, and a
   * token nobody has used is the strongest candidate - somebody issued it,
   * something changed, and it has been sitting there ever since with whatever
   * it was given.
   */
  return rows.sort((a, b) => {
    if (!a.lastUsedAt !== !b.lastUsedAt)
      return a.lastUsedAt ? 1 : -1

    if (a.lastUsedAt && b.lastUsedAt)
      return a.lastUsedAt.localeCompare(b.lastUsedAt)

    return a.name.localeCompare(b.name)
  })
}

/**
 * The organizations a caller administers that one token reaches.
 *
 * Used to decide whether somebody may revoke a token that is not theirs, so it
 * answers the two halves together: administering an organization the token
 * cannot touch is not a reason, and a token reaching an organization the caller
 * does not administer is not their business.
 *
 * Returns handles rather than ids, because the answer goes into an audit row
 * and into a refusal message, and both are read by people.
 */
export async function organizationsReachedBy(tokenId: number, callerId: number): Promise<string[]> {
  if (!tokenId || !callerId)
    return []

  const administered = await db
    .selectFrom('org_members')
    .select(['organization_id', 'role', 'joined_at'])
    .where('user_id', '=', callerId)
    .execute()

  const candidates = administered
    .filter(row => Boolean(row.joined_at) && canInOrganization(String(row.role) as any, 'settings:manage'))
    .map(row => Number(row.organization_id))

  if (candidates.length === 0)
    return []

  const reached: string[] = []

  for (const organizationId of candidates) {
    // Re-read the role through the one function that knows what a pending
    // invitation is, rather than trusting the row above twice.
    const role = await organizationRoleOf(organizationId, callerId)
    if (!canInOrganization(role, 'settings:manage'))
      continue

    const tokens = await tokensReaching(organizationId)
    if (!tokens.some(token => token.id === Number(tokenId)))
      continue

    const organization = await db
      .selectFrom('organizations')
      .select(['handle'])
      .where('id', '=', organizationId)
      .executeTakeFirst()

    if (organization?.handle)
      reached.push(String(organization.handle))
  }

  return reached
}
