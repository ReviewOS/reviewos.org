/**
 * What the organization pages need, read in one place.
 *
 * The settings page and the people page both want "who is in this, with what
 * role, and since when", and getting that twice is how two pages come to
 * disagree about whether a pending invitation counts.
 */

/** An organization as the settings list shows it. */
export interface OrganizationRow {
  id: number
  handle: string
  name: string
  description: string
  role: 'owner' | 'admin' | 'member'
  /** Null while the invitation is unanswered. */
  joinedAt: string | null
  memberCount: number
  repositoryCount: number
}

/** Somebody in an organization, as the people page shows them. */
export interface PersonRow {
  id: number
  handle: string
  name: string
  avatarUrl: string
  role: 'owner' | 'admin' | 'member'
  joinedAt: string | null
  pending: boolean
}

/**
 * Every organization somebody is in or has been invited to.
 *
 * Invitations come back in the same list, marked, rather than in a second one.
 * There is one place to look for "my organizations" and an unanswered
 * invitation is the thing most worth seeing there - a separate section is a
 * separate thing to remember to render, and the notification already points
 * here.
 */
export async function organizationsFor(userId: number): Promise<OrganizationRow[]> {
  if (!userId)
    return []

  const memberships: any[] = await db
    .selectFrom('org_members')
    .select(['organization_id', 'role', 'joined_at'])
    .where('user_id', '=', userId)
    .execute()

  if (memberships.length === 0)
    return []

  const ids = memberships.map(row => Number(row.organization_id))

  const organizations: any[] = await db
    .selectFrom('organizations')
    .select(['id', 'handle', 'name', 'description'])
    .where('id', 'in', ids)
    .execute()

  const byId = new Map(organizations.map(row => [Number(row.id), row]))

  // Counted in two queries rather than two per organization. A person in a
  // dozen organizations would otherwise make this page twenty-five round trips.
  const memberCounts = await countBy('org_members', 'organization_id', ids)
  const repositoryCounts = await repositoryCountsFor(ids)

  const rows: OrganizationRow[] = []

  for (const membership of memberships) {
    const id = Number(membership.organization_id)
    const organization = byId.get(id)
    if (!organization)
      continue

    rows.push({
      id,
      handle: String(organization.handle),
      name: String(organization.name || organization.handle),
      description: String(organization.description ?? ''),
      role: String(membership.role) as OrganizationRow['role'],
      joinedAt: membership.joined_at ? String(membership.joined_at) : null,
      memberCount: memberCounts.get(id) ?? 0,
      repositoryCount: repositoryCounts.get(id) ?? 0,
    })
  }

  // Invitations first, then alphabetically. The unanswered thing is the one the
  // reader came for.
  return rows.sort((a, b) => {
    if (!a.joinedAt !== !b.joinedAt)
      return a.joinedAt ? 1 : -1

    return a.handle.localeCompare(b.handle)
  })
}

/**
 * Everybody in an organization, invitations included and marked.
 *
 * Only for somebody who may see the list: `members:view` is a member's right,
 * and an organization's membership is not public. Callers pass the viewer's
 * role rather than the viewer, so the page that already resolved it does not
 * resolve it twice.
 */
export async function peopleIn(organizationId: number): Promise<PersonRow[]> {
  const memberships: any[] = await db
    .selectFrom('org_members')
    .select(['user_id', 'role', 'joined_at'])
    .where('organization_id', '=', organizationId)
    .execute()

  if (memberships.length === 0)
    return []

  const users: any[] = await db
    .selectFrom('users')
    .select(['id', 'handle', 'name', 'avatar_url'])
    .where('id', 'in', memberships.map(row => Number(row.user_id)))
    .execute()

  const byId = new Map(users.map(row => [Number(row.id), row]))
  const rank = { owner: 0, admin: 1, member: 2 } as const

  const people: PersonRow[] = []

  for (const membership of memberships) {
    const user = byId.get(Number(membership.user_id))
    if (!user)
      continue

    people.push({
      id: Number(user.id),
      handle: String(user.handle),
      name: String(user.name || user.handle),
      avatarUrl: String(user.avatar_url ?? ''),
      role: String(membership.role) as PersonRow['role'],
      joinedAt: membership.joined_at ? String(membership.joined_at) : null,
      pending: !membership.joined_at,
    })
  }

  // Owners, then admins, then members, alphabetically within each. Who runs
  // this is the question the page is usually open to answer.
  return people.sort((a, b) => rank[a.role] - rank[b.role] || a.handle.localeCompare(b.handle))
}

/** How many rows each id has, in one query. */
async function countBy(table: string, column: string, ids: readonly number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (ids.length === 0)
    return counts

  const rows: any[] = await db
    .selectFrom(table as any)
    .select([column as any])
    .where(column as any, 'in', [...ids])
    .execute()

  for (const row of rows) {
    const id = Number((row as any)[column])
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return counts
}

/** Repositories per organization, counted the polymorphic way. */
async function repositoryCountsFor(ids: readonly number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (ids.length === 0)
    return counts

  const rows: any[] = await db
    .selectFrom('repositories')
    .select(['owner_id'])
    .where('owner_type', '=', 'organization')
    .where('owner_id', 'in', [...ids])
    .execute()

  for (const row of rows) {
    const id = Number(row.owner_id)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return counts
}
