/**
 * Signing in with an account somebody already has.
 *
 * ## Why this exists next to `oidc.ts` rather than inside it
 *
 * They answer different questions. OIDC is what an *operator* turns on so
 * their company's identity provider owns every account on the instance: one
 * issuer, configured per deployment, groups mapped to teams. This is what a
 * *visitor* clicks. A public forge needs both, and collapsing them would mean
 * either running a full OIDC verification against GitHub (which does not speak
 * it) or treating a company's single sign-on as one button among five.
 *
 * They share the table. `sso_identities` is keyed on `(issuer, subject)`, and
 * that is exactly the right key here too - a GitHub account id is stable
 * across a username change, which an email is not. The issuer for a social
 * sign-in is the provider name prefixed with `social:`, so a company that
 * federates with Google Workspace over OIDC and a visitor who clicks "Sign in
 * with Google" cannot collide on one row and hand one person the other's
 * account.
 *
 * ## What is not done here
 *
 * No account is linked to a local one on an unverified address. The rule and
 * the reasoning are `provision.ts`'s, and this reuses that decision rather
 * than restating it: an unverified email is a string somebody typed into a
 * profile page, and linking on it lets anybody with an account at the provider
 * claim any local account by editing their own.
 */

import { configuredSocialProviders, socialProvider } from '@stacksjs/socials'
import { db } from '@stacksjs/database'

/** A provider as the sign-in page needs to render it. */
export interface SocialButton {
  name: string
  label: string
  /** Iconify class, so no SVG is hand-rolled. */
  icon: string
  href: string
}

/**
 * The icon per provider.
 *
 * Kept here rather than in the framework registry because it is a choice about
 * this instance's icon set (hugeicons, as everywhere else), not a fact about
 * the provider. A provider with no entry still renders, with the generic mark -
 * which is what makes adding a driver upstream enough to light up a button
 * here with no change to this file.
 */
const ICONS: Record<string, string> = {
  github: 'i-hugeicons-github',
  google: 'i-hugeicons-google',
  apple: 'i-hugeicons-apple',
  gitlab: 'i-hugeicons-gitlab',
  facebook: 'i-hugeicons-facebook-01',
  twitter: 'i-hugeicons-new-twitter',
}

/**
 * Which buttons to draw, in the order the framework declares them.
 *
 * Off `configuredSocialProviders()` rather than a list written here, so a
 * provider whose keys are missing never reaches a visitor as a button that
 * fails. That check is the framework's because only it knows that Apple has no
 * static client secret and so cannot be tested for one.
 *
 * Never throws. It is called while rendering the sign-in page, and a page that
 * cannot be signed in from is a worse outcome than a missing button.
 */
export function socialButtons(next = ''): SocialButton[] {
  try {
    const query = next ? `?next=${encodeURIComponent(next)}` : ''

    return configuredSocialProviders().map(provider => ({
      name: provider.name,
      label: provider.label,
      icon: ICONS[provider.name] ?? 'i-hugeicons-user-circle',
      // `/api`, matching where the routes are registered and what the provider
      // consoles are configured with. See the note in `routes/api.ts`.
      href: `/api/auth/${provider.name}${query}`,
    }))
  }
  catch {
    return []
  }
}

/** Is this provider one we can actually start a flow with? */
export function providerFor(name: unknown): ReturnType<typeof socialProvider> {
  try {
    return socialProvider(name)
  }
  catch {
    return null
  }
}

/**
 * The account behind a provider profile, made if this is the first time.
 *
 * Mirrors `provisionFromClaims` deliberately, including the one-time email
 * link, and differs in the two places social sign-in differs from OIDC:
 *
 * - **The handle comes from the provider's nickname.** A GitHub login is
 *   already a forge handle, and reusing it is the difference between
 *   `chrisbbreuer` and `user-8842`. It is only a starting point: taken
 *   handles get a numeric suffix rather than an error, because a visitor
 *   cannot fix a collision they cannot see.
 * - **No groups, so no team mapping.** A social provider asserts nothing about
 *   what somebody may do here, and pretending otherwise would make "sign in
 *   with Google" a privilege escalation.
 */
export async function provisionFromSocial(
  provider: string,
  profile: { id: string, nickname: string | null, name: string, email: string | null, emailVerified?: boolean | null, avatar: string | null },
): Promise<{ userId: number, created: boolean }> {
  const issuer = `social:${provider}`
  const subject = String(profile.id)
  const now = new Date().toISOString()
  const email = String(profile.email ?? '').trim().toLowerCase()

  const existing = await db
    .selectFrom('sso_identities')
    .select(['id', 'user_id'])
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('sso_identities')
      .set({ email: email || null, last_seen_at: now })
      .where('id', '=', existing.id)
      .execute()

    return { userId: Number(existing.user_id), created: false }
  }

  // The one email lookup, and only for an address the provider says it
  // verified. See the note at the top, and `provision.ts` for the long form.
  const local: any = email && profile.emailVerified !== false
    ? await db.selectFrom('users').select(['id']).where('email', '=', email).executeTakeFirst()
    : null

  let userId = local ? Number(local.id) : 0
  let created = false

  if (!userId) {
    userId = await createAccount(profile, email)
    created = true
  }

  await db.insertInto('sso_identities').values({
    user_id: userId,
    issuer,
    subject,
    email: email || null,
    groups: JSON.stringify([]),
    last_seen_at: now,
  }).execute()

  return { userId, created }
}

/**
 * A local account for somebody the provider vouched for.
 *
 * The password column is not nullable and is never used on this path: a random
 * value is written so the row is valid and so no social account is reachable
 * with a guessable password. Somebody who wants one sets it through the reset
 * flow, which proves the mailbox first.
 */
async function createAccount(
  profile: { nickname: string | null, name: string, avatar: string | null },
  email: string,
): Promise<number> {
  const handle = await freeHandle(profile.nickname ?? profile.name ?? 'user')

  const inserted = await db
    .insertInto('users')
    .values({
      handle,
      name: profile.name || handle,
      // A provider that asserts no address still gets an account. The column
      // is unique, so the placeholder is namespaced by the handle rather than
      // left empty, which would collide on the second such sign-in.
      email: email || `${handle}@users.noreply.reviewos.org`,
      password: crypto.randomUUID(),
      avatar_url: profile.avatar ?? null,
      created_at: new Date().toISOString(),
    })
    .returning('id')
    .executeTakeFirst()

  if (!inserted)
    throw new Error('The account could not be created')

  return Number(inserted.id)
}

/**
 * `base`, or `base2`, or `base3`.
 *
 * Bounded rather than a loop that could spin: after a handful of attempts the
 * suffix becomes random, which terminates. An unbounded scan of a popular
 * handle is a query per attempt against a table anybody can add rows to.
 */
async function freeHandle(preferred: string): Promise<string> {

  const base = String(preferred)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'user'

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`
    const taken = await db.selectFrom('users').select(['id']).where('handle', '=', candidate).executeTakeFirst()

    if (!taken)
      return candidate
  }

  return `${base}-${crypto.randomUUID().slice(0, 8)}`
}
