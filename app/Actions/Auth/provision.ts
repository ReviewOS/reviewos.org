/**
 * Turning a verified set of claims into somebody who can use this instance.
 *
 * The protocol half is in `oidc.ts` and stops at "these claims are genuine".
 * This is the half that decides what genuine claims *mean* here, and every
 * decision in it is about not doing damage to an account that already exists.
 */

import process from 'node:process'

import type { OidcClaims } from './oidc'

export interface ProvisionResult {
  userId: number
  handle: string
  created: boolean
  teamsJoined: string[]
  teamsLeft: string[]
}

/**
 * The account these claims belong to, made if it is not there yet.
 *
 * ## Matched on `sub`, and on email only once
 *
 * The lookup is `(issuer, sub)`, which is stable across a name change, a
 * marriage, a domain rename and an address being recycled to a different
 * person. Email is used for exactly one thing: **the first time** a provider
 * presents somebody whose address already has a local account, the two are
 * linked rather than a duplicate being made.
 *
 * That one use is deliberate and narrow. Without it, turning on single sign-on
 * on an existing instance gives everybody a second empty account and strands
 * their review history. With it applied on *every* sign-in, a recycled address
 * would hand a new joiner the leaver's account - so it happens once, at
 * linking, and the link is what is consulted forever after.
 *
 * The email must be one the provider says it verified. An unverified address is
 * a string somebody typed into a profile page, and linking on it would let
 * anybody with an account at the provider claim any local account by editing
 * their own email.
 */
export async function provisionFromClaims(claims: OidcClaims, issuer: string): Promise<ProvisionResult> {
  const db = (globalThis as any).db
  const subject = String(claims.sub)

  const existing: any = await db
    .selectFrom('sso_identities')
    .select(['id', 'user_id'])
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirst()

  const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : []
  let userId = existing ? Number(existing.user_id) : 0
  let created = false

  if (!userId) {
    const email = String(claims.email ?? '').trim().toLowerCase()

    // The one email lookup, and only for an address the provider verified.
    const local: any = email && claims.email_verified !== false
      ? await db.selectFrom('users').select(['id']).where('email', '=', email).executeTakeFirst()
      : null

    if (local) {
      userId = Number(local.id)
    }
    else {
      userId = await createAccount(claims)
      created = true
    }

    await db.insertInto('sso_identities').values({
      user_id: userId,
      issuer,
      subject,
      email: email || null,
      groups: JSON.stringify(groups),
      last_seen_at: new Date().toISOString(),
    }).execute()
  }
  else {
    await db
      .updateTable('sso_identities')
      .set({
        email: String(claims.email ?? '').trim().toLowerCase() || null,
        groups: JSON.stringify(groups),
        last_seen_at: new Date().toISOString(),
      })
      .where('id', '=', Number(existing.id))
      .execute()
  }

  const row: any = await db.selectFrom('users').select(['handle']).where('id', '=', userId).executeTakeFirst()
  const membership = await syncTeams(userId, groups)

  return { userId, handle: String(row?.handle ?? ''), created, ...membership }
}

/**
 * A new account from claims.
 *
 * The handle comes from `preferred_username` when the provider sends one and
 * from the local part of the email otherwise, and either way it is made safe
 * and made unique - a provider's idea of a username and a forge's are different
 * shapes, and a collision must not fail the sign-in.
 *
 * No password is set. There is nothing to set it to, and an account with no
 * password cannot be signed into by the password form - which is right: a
 * provisioned account belongs to the provider until somebody deliberately gives
 * it a local password.
 */
async function createAccount(claims: OidcClaims): Promise<number> {
  const db = (globalThis as any).db
  const email = String(claims.email ?? '').trim().toLowerCase()
  const suggested = String(claims.preferred_username ?? '').trim() || email.split('@')[0] || `user${Date.now()}`

  /*
   * The address is recorded only if it is genuinely free.
   *
   * We reach here having decided *not* to link - either the provider did not
   * verify the address, or it belongs to nobody. Writing an unverified address
   * that another account already holds would fail on the unique constraint and
   * turn a refusal-to-link into a refusal-to-*sign-in*, which is the worse
   * outcome: the person is shut out over a decision that was made to protect
   * somebody else's account.
   *
   * `users.email` is not null, so the fallback is a placeholder rather than
   * nothing: `.invalid` is reserved by RFC 2606 so that it can never resolve,
   * which makes the address unmistakably not a real one, impossible to collide
   * with, and impossible to send to by accident. The person can set a real one
   * once they can prove it.
   */
  const taken = email
    ? await db.selectFrom('users').select(['id']).where('email', '=', email).executeTakeFirst()
    : null

  const created: any = await db
    .insertInto('users')
    .values({
      handle: await uniqueHandle(suggested),
      name: String(claims.name ?? '').trim() || suggested,
      email: !email || taken ? `sso-${await shortHash(String(claims.sub))}@unverified.invalid` : email,
      // Not null on the column, and deliberately not a usable hash: `''` is not
      // a bcrypt digest, so the password form can never match it.
      password: '',
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(created?.id)
}

/** Twelve hex characters of the subject, so the placeholder is stable and unique. */
async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))

  return [...new Uint8Array(digest)].slice(0, 6).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A handle nobody has, from something the provider suggested. */
async function uniqueHandle(suggested: string): Promise<string> {
  const db = (globalThis as any).db
  const base = suggested.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'user'

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    const taken = await db.selectFrom('users').select(['id']).where('handle', '=', candidate).executeTakeFirst()

    if (!taken)
      return candidate
  }

  // Fifty collisions on one name means something odd; a random suffix is better
  // than failing a sign-in over a handle.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Team membership, from the groups the provider asserted.
 *
 * ## The provider is the authority, so this removes as well as adds
 *
 * A mapping that only ever adds is the failure people ship: somebody moves off
 * a team at the identity provider, the group disappears from their token, and
 * their access here stays exactly as it was. Then the whole point of federating
 * - one place to change somebody's access - is gone, and nobody notices because
 * everything still works.
 *
 * ## Scoped to one organization, and that is a correctness requirement
 *
 * A team slug is unique *within an organization*, not across the instance -
 * "platform" and "security" exist in as many organizations as have them. The
 * first version of this matched every team with a matching slug and would have
 * put somebody on the platform team of an organization they had never heard of,
 * on the strength of a group name at their own company's provider. A probe
 * found it: seven teams on this instance, two of them called `platform`.
 *
 * So the operator names the organization whose teams the provider manages. One
 * provider, one directory, one organization - and every other organization on
 * the instance is none of its business.
 *
 * ## Only teams whose slug a group actually names
 *
 * Removal is scoped to teams inside that organization whose slug is
 * group-shaped, so a team somebody was put on by hand is left alone. Otherwise
 * turning on single sign-on would silently empty every team that does not
 * correspond to a group, which is most of them on a real instance.
 */
async function syncTeams(userId: number, groups: string[]): Promise<{ teamsJoined: string[], teamsLeft: string[] }> {
  const db = (globalThis as any).db
  const joined: string[] = []
  const left: string[] = []

  const organizationHandle = managedOrganization()

  if (!organizationHandle)
    return { teamsJoined: joined, teamsLeft: left }

  try {
    const organization: any = await db
      .selectFrom('organizations')
      .select(['id'])
      .where('handle', '=', organizationHandle)
      .executeTakeFirst()

    if (!organization) {
      // Named but absent. Logged rather than ignored: an operator who typed the
      // handle wrong should find out from a line in the log, not from group
      // mapping silently never happening.
      console.error(`[sso] SSO_TEAM_ORGANIZATION names "${organizationHandle}", which is not an organization here`)

      return { teamsJoined: joined, teamsLeft: left }
    }

    const wanted = new Set(groups.map(group => group.toLowerCase().replace(/[^a-z0-9-]/g, '-')))

    // Every team in that one organization, whether or not this person is in it.
    // That set is what "managed by the provider" means here.
    const managed: any[] = await db
      .selectFrom('teams')
      .select(['id', 'slug'])
      .where('organization_id', '=', Number(organization.id))
      .execute()
    const mapped = managed.filter(team => wanted.has(String(team.slug).toLowerCase()))

    const held: any[] = await db.selectFrom('team_members').select(['id', 'team_id']).where('user_id', '=', userId).execute()
    const heldIds = new Set(held.map(row => Number(row.team_id)))

    for (const team of mapped) {
      if (heldIds.has(Number(team.id)))
        continue

      await db.insertInto('team_members').values({ team_id: Number(team.id), user_id: userId, role: 'member' }).execute()
      joined.push(String(team.slug))
    }

    const wantedIds = new Set(mapped.map(team => Number(team.id)))
    const bySlug = new Map(managed.map(team => [Number(team.id), String(team.slug)]))

    for (const row of held) {
      const id = Number(row.team_id)
      const slug = bySlug.get(id) ?? ''

      // Left only when the team's slug looks like a group the provider manages
      // and this token did not carry it. A team nobody's groups ever name is
      // not this system's business.
      if (wantedIds.has(id) || !slug || !isGroupShaped(slug))
        continue

      await db.deleteFrom('team_members').where('id', '=', Number(row.id)).execute()
      left.push(slug)
    }
  }
  catch (error) {
    // Logged rather than swallowed: a mapping that quietly does nothing is the
    // same as no mapping, and an operator watching a group take effect deserves
    // to know it threw.
    console.error('[sso] could not map groups to teams:', error)
  }

  return { teamsJoined: joined, teamsLeft: left }
}

/**
 * The organization whose teams the provider manages, if any.
 *
 * Off unless an operator names one. Turning on single sign-on should not
 * silently start editing team membership on an instance whose teams were
 * curated by hand - and the removal half of the mapping is destructive enough
 * that it needs to have been chosen deliberately, for a named organization.
 */
function managedOrganization(): string {
  return String(process.env.SSO_TEAM_ORGANIZATION ?? '').trim().toLowerCase()
}

/** Whether a slug is the shape a group maps to, so removal stays in its lane. */
function isGroupShaped(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug)
}

/**
 * End everything a person can sign in with.
 *
 * The deprovisioning primitive, and it is deliberately blunt: every session,
 * every refresh token, and every personal access token. A credential that
 * outlives the account it was granted under is the whole failure this exists to
 * prevent, and half-revoking is how it happens - somebody remembers sessions
 * and forgets the token pasted into a build server three months ago.
 *
 * The account itself is left alone. Deleting it would take their review history
 * and every comment they wrote with it, and "this person has left" is not the
 * same statement as "this work never happened".
 */
export async function revokeEverything(userId: number): Promise<{ sessions: number, tokens: number }> {
  const db = (globalThis as any).db
  let sessions = 0
  let tokens = 0

  try {
    const rows: any[] = await db.selectFrom('oauth_access_tokens').select(['id']).where('user_id', '=', userId).execute()
    sessions = rows.length

    /*
     * Refresh tokens go first, and by `access_token_id`.
     *
     * `oauth_refresh_tokens` has **no `user_id` column** - it hangs off the
     * access token. The first version of this deleted `where('user_id', ...)`
     * there, which throws, was caught and logged, and then the access tokens
     * were deleted anyway - leaving orphaned refresh tokens behind. A refresh
     * token that outlives the session it belonged to is precisely the
     * credential-outliving-the-account failure this function exists to prevent,
     * and it would have been left in place by the function named
     * `revokeEverything`.
     */
    if (rows.length > 0) {
      await db
        .deleteFrom('oauth_refresh_tokens')
        .where('access_token_id', 'in', rows.map(row => Number(row.id)))
        .execute()
    }

    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', userId).execute()
  }
  catch (error) {
    console.error('[sso] could not revoke sessions:', error)
  }

  try {
    const rows: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', userId).execute()
    tokens = rows.length

    for (const row of rows)
      await db.deleteFrom('access_token_permissions').where('access_token_id', '=', Number(row.id)).execute()

    await db.deleteFrom('access_tokens').where('user_id', '=', userId).execute()
  }
  catch (error) {
    console.error('[sso] could not revoke tokens:', error)
  }

  return { sessions, tokens }
}
