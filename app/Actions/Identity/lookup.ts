import { canInOrganization } from '../../Permissions'
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

/**
 * The signed-in user, or null.
 *
 * `request.user()` is filled in by the `auth` middleware, and a route that does
 * not carry that middleware never gets one - which is most of the read
 * endpoints, on purpose: a public repository's issues and files are public, so
 * requiring authentication to reach them would be wrong.
 *
 * The consequence was not obvious and was wrong everywhere. On those routes the
 * `Authorization` header was never looked at, so an authenticated caller was
 * indistinguishable from a stranger, and **every private repository answered
 * 404 to its own owner** through the JSON API. It reads as a permission bug and
 * is really an absent one: there was nobody to permit.
 *
 * So the header is resolved here when the middleware has not already done it.
 * Only the framework's own bearer token, which is exactly what that middleware
 * accepts - the same credential, resolved in the same way, one step later.
 *
 * Deliberately **not** this application's fine-grained tokens. Those carry a
 * reach and a set of grants, and answering "who is this" with a bare user id
 * would drop both: a read-only token scoped to one repository would arrive
 * here as its owner, with everything its owner can do. They are resolved where
 * those limits are enforced instead - `tokenFromBasicAuth` and
 * `browseContext`, which pass the whole token to the permission check.
 */
export async function currentUser(request: any): Promise<{ id: number, handle: string, is_admin: boolean } | null> {
  const user = await request.user?.()
  const id = Number(user?.id ?? 0)
    || await frameworkTokenUserId(request)
    || await cookieUserId(request)

  if (!id)
    return null

  const row = await db
    .selectFrom('users')
    .select(['id', 'handle', 'is_admin'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!row)
    return null

  return { id: Number(row.id), handle: String(row.handle), is_admin: Boolean(row.is_admin) }
}

/**
 * The user behind an `Authorization: Bearer` header, for routes with no auth
 * middleware.
 *
 * Never throws: an expired or unknown token is an ordinary state for a request
 * to be in, and it has to read as "nobody is signed in" rather than as a failed
 * request - the endpoint may well serve a public repository perfectly happily.
 */
async function frameworkTokenUserId(request: any): Promise<number> {
  const header = String(
    request.headers?.get?.('authorization') ?? request.header?.('authorization') ?? '',
  )

  if (!header.startsWith('Bearer '))
    return 0

  const token = header.slice('Bearer '.length).trim()

  // This application's own tokens start with their scheme, and are deliberately
  // not resolved here. See the note above.
  if (!token || token.startsWith('ros_'))
    return 0

  try {
    const { Auth } = await import('@stacksjs/auth')
    const found = await Auth.getUserFromToken(token)

    return Number((found as any)?.id ?? 0) || 0
  }
  catch {
    return 0
  }
}

/**
 * The user behind a session cookie, for routes with no auth middleware.
 *
 * The same gap the bearer resolution above closes, for the credential a
 * *browser* actually holds. A page signs somebody in with a cookie - that is
 * what `viewerFromCookies` reads on every rendered page - and a `fetch` from
 * that page sends it automatically and sends no `Authorization` header at all.
 * So an endpoint outside the auth middleware saw a stranger, and answered every
 * signed-in reader as though nobody were there.
 *
 * Found on the review-state endpoint, which reported `signed_in: false` to a
 * reader whose cookie was right there on the request, so their progress would
 * never have been read back on any machine. It reads as an empty database and
 * is really an absent identity.
 *
 * Safe on writes because CSRF is not this function's job and never was: the
 * router checks a double-submit token on every non-safe method, so a cookie
 * arriving on a cross-site request cannot be spent here.
 *
 * The exception worth knowing about is `routes/git.ts`, where the wire protocol
 * and the LFS endpoints call `.skipCsrf()` - a git client has no token to
 * double-submit. Those authenticate through `tokenFromBasicAuth` and never
 * reach this function, which is what keeps a browser cookie from being spent on
 * a push. Anything added there that wants a *user* has to keep that true.
 */
async function cookieUserId(request: any): Promise<number> {
  const header = String(
    request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? '',
  )

  if (!header)
    return 0

  const found = await viewerFromCookies(cookieJarFromHeader(header))
  return found?.id ?? 0
}

/**
 * A `Cookie` header, parsed into the record `viewerFromCookies` reads.
 *
 * Exported for the pages served without a parsed cookie jar: the frontend
 * server hands views `__stxServeContext.cookies` ready-made, but a page
 * rendered through `route.serve()`'s file routing gets the raw headers and
 * nothing else, and a view that only asks for the jar renders every reader
 * there as a stranger.
 */
export function cookieJarFromHeader(header: unknown): Record<string, string> {
  const jar: Record<string, string> = {}

  for (const part of String(header ?? '').split(';')) {
    const cut = part.indexOf('=')
    if (cut < 0)
      continue

    try {
      jar[part.slice(0, cut).trim()] = decodeURIComponent(part.slice(cut + 1).trim())
    }
    catch {
      // A malformed escape in one cookie is not a reason to drop the others.
    }
  }

  return jar
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

/**
 * Somebody's role in an organization, or null when they are not a member.
 *
 * **A pending invitation is not a membership.** An invited row exists with the
 * role it will carry and a null `joined_at`, and the whole point of asking
 * somebody to accept is that they have not yet. Answering with the role before
 * they do would hand out the access the invitation is offering at the moment it
 * is offered, which is not an invitation at all.
 *
 * The filter lives here rather than at each call site because there are dozens
 * of those and one of them will be written without it. This function is the
 * only thing in the codebase that turns an `org_members` row into an answer
 * about what somebody may do.
 */
export async function organizationRoleOf(organizationId: number, userId: number): Promise<'owner' | 'admin' | 'member' | null> {
  const row = await db
    .selectFrom('org_members')
    .select(['role', 'joined_at'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst()

  if (!row || !row.joined_at)
    return null

  return (row.role as 'owner' | 'admin' | 'member' | undefined) ?? null
}

/**
 * How many owners an organization has. Used before removing or demoting one.
 *
 * Counts accepted owners only, for the same reason. An organization whose only
 * owner has been invited and has not accepted has no owner, and treating the
 * invitation as one would let the last real owner demote themselves on the
 * strength of somebody who may never arrive.
 */
export async function organizationOwnerCount(organizationId: number): Promise<number> {
  const rows = await db
    .selectFrom('org_members')
    .select(['id', 'joined_at'])
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'owner')
    .execute()

  return rows.filter((row: any) => Boolean(row.joined_at)).length
}

/**
 * The owners somebody may create a repository under.
 *
 * Their own account, then the organizations they belong to. The membership
 * check is the same rule the create endpoint enforces, read from the same
 * table: a page that offers an owner the endpoint would refuse is a page that
 * hands somebody a 403 after they have filled in a form.
 */
export async function ownersForCreate(
  user: { id: number, handle: string },
): Promise<{ handle: string, kind: 'user' | 'organization' }[]> {
  const memberships: any[] = await db
    .selectFrom('org_members')
    .select(['organization_id', 'role', 'joined_at'])
    .where('user_id', '=', user.id)
    .execute()

  // `joined_at` first, for the reason written on `organizationRoleOf`: a
  // pending invitation is not a membership, and offering somebody an
  // organization they have not joined would have the create endpoint refuse
  // them after they filled in the form - which is the exact failure this
  // function exists to prevent, pointed the other way.
  const allowed = memberships.filter(row => Boolean(row.joined_at)
    && canInOrganization(String(row.role) as any, 'repositories:create'))

  if (allowed.length === 0)
    return [{ handle: user.handle, kind: 'user' }]

  const ids = allowed.map(row => Number(row.organization_id))

  // Scoped to the ids in hand. Reading every organization on the instance to
  // resolve a handful of handles is the query that gets slow first, and it does
  // so on the page somebody opens to create their first repository.
  const organizations: any[] = await db
    .selectFrom('organizations')
    .select(['id', 'handle'])
    .where('id', 'in', ids)
    .execute()

  const byId = new Map(organizations.map(row => [Number(row.id), String(row.handle)]))

  return [
    { handle: user.handle, kind: 'user' as const },
    ...allowed
      .map(row => byId.get(Number(row.organization_id)))
      .filter((handle): handle is string => Boolean(handle))
      .sort()
      .map(handle => ({ handle, kind: 'organization' as const })),
  ]
}
