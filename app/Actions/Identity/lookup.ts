import { checkHandle, normalizeHandle } from './handles'

/**
 * Reading identity out of the database.
 *
 * Kept apart from the pure handle rules so those stay testable without a
 * database, and so every action asks the same questions the same way.
 */

export interface OwnerRef {
  kind: 'user' | 'organization'
  id: number
  handle: string
}

/** Whether a handle is free across BOTH namespaces. */
export async function handleAvailable(raw: string): Promise<{ ok: boolean, message?: string }> {
  const check = checkHandle(raw)
  if (!check.ok)
    return { ok: false, message: check.message }

  const handle = normalizeHandle(raw)

  const user = await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()
  if (user)
    return { ok: false, message: 'That handle is taken.' }

  const organization = await db
    .selectFrom('organizations')
    .select(['id'])
    .where('handle', '=', handle)
    .executeTakeFirst()
  if (organization)
    return { ok: false, message: 'That handle is taken.' }

  return { ok: true }
}

/** Resolve a handle to whoever owns it, user or organization. */
export async function resolveOwner(raw: string): Promise<OwnerRef | null> {
  const handle = normalizeHandle(raw)

  const user = await db.selectFrom('users').select(['id', 'handle']).where('handle', '=', handle).executeTakeFirst()
  if (user)
    return { kind: 'user', id: Number(user.id), handle: String(user.handle) }

  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'handle'])
    .where('handle', '=', handle)
    .executeTakeFirst()
  if (organization)
    return { kind: 'organization', id: Number(organization.id), handle: String(organization.handle) }

  return null
}

/** The signed-in user, or null. */
export async function currentUser(request: any): Promise<{ id: number, handle: string, is_admin: boolean } | null> {
  const user = await request.user?.()
  if (!user?.id)
    return null

  const row = await db
    .selectFrom('users')
    .select(['id', 'handle', 'is_admin'])
    .where('id', '=', Number(user.id))
    .executeTakeFirst()

  if (!row)
    return null

  return { id: Number(row.id), handle: String(row.handle), is_admin: Boolean(row.is_admin) }
}

/** Somebody's role in an organization, or null when they are not a member. */
export async function organizationRoleOf(organizationId: number, userId: number): Promise<'owner' | 'admin' | 'member' | null> {
  const row = await db
    .selectFrom('org_members')
    .select(['role'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst()

  return (row?.role as 'owner' | 'admin' | 'member' | undefined) ?? null
}

/** How many owners an organization has. Used before removing or demoting one. */
export async function organizationOwnerCount(organizationId: number): Promise<number> {
  const rows = await db
    .selectFrom('org_members')
    .select(['id'])
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'owner')
    .execute()

  return rows.length
}
