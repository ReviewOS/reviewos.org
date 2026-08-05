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

/**
 * Resolve `owner/name` to the repository row, or null.
 *
 * The owner is resolved first and the repository is looked up *within* that
 * owner, which is the part that matters: a query on the name alone finds a
 * repository belonging to somebody else, and every page built on it then shows
 * one person's work under another person's handle.
 */
export async function resolveRepository(owner: string, name: string): Promise<any | null> {
  const found = await resolveOwner(owner)
  if (!found)
    return null

  const row = await db
    .selectFrom('repositories')
    .selectAll()
    .where('owner_type', '=', found.kind)
    .where('owner_id', '=', found.id)
    .where('name', '=', name)
    .executeTakeFirst()

  return row ?? null
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

/**
 * The signed-in user, from cookies rather than from a request object.
 *
 * An stx `<script server>` block has no `request`. What it has is
 * `__stxServeContext`, and the only thing on it that identifies anybody is the
 * `Cookie` header, already parsed. So a page that needs to know who is reading
 * it - to show which reactions are already theirs, to offer an edit link on
 * their own comment - comes through here.
 *
 * The two cookies are the two the auth middleware accepts, checked in the same
 * order, so a page and the endpoint its forms post to never disagree about who
 * is signed in.
 *
 * **Never throws.** stx renders a page with every variable undefined when a
 * server script throws, and reports nothing: the symptom is a blank region or a
 * not-found branch, never a stack trace. An expired cookie is an ordinary state
 * for a page to be in, and it must read as "nobody is signed in" rather than as
 * an empty page.
 */
export async function viewerFromCookies(
  cookies: Record<string, string> | undefined | null,
): Promise<{ id: number, handle: string, is_admin: boolean } | null> {
  if (!cookies)
    return null

  try {
    const { Auth, sessionUser } = await import('@stacksjs/auth')
    const { config } = await import('@stacksjs/config')

    const tokenCookie = cookies[config.auth?.defaultTokenName || 'auth-token']
    const user = tokenCookie
      ? await Auth.getUserFromToken(tokenCookie)
      : (cookies.session_id ? await sessionUser(cookies.session_id) : null)

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
  catch {
    return null
  }
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
