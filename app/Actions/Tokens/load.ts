/**
 * Reading tokens, for a page rather than for an API client.
 *
 * `ListTokensAction` answers with the rows. This answers with sentences, and
 * the difference is the whole point of the page: a list of tokens showing
 * `contents: write` is a list nobody prunes, because deciding whether that
 * matters means knowing what `contents` covers. A token that nobody can
 * interpret is a token that survives for two years and turns up in an incident.
 *
 * So every grant is described in the same words the permission checks use, and
 * a token's reach is named as repositories rather than as a count. `all` is
 * spelled out as what it is - everything the account can reach, now and in
 * future - because that is the grant people pick by accident.
 */

import type { TokenGrant, TokenLevel, TokenScope } from '../../TokenScopes'
import { db } from '@stacksjs/database'
import { tokenState } from '../../TokenScopes'
import { maskToken } from './secret'

/**
 * What each scope covers, at each level, in the words of the checks.
 *
 * Written out rather than derived from `REPOSITORY_ABILITY_SCOPES`, which maps
 * the other way: an ability names its scope, and inverting that gives a list of
 * ability strings, not a sentence. A reader deciding whether to revoke
 * something needs the sentence.
 */
const SCOPE_SENTENCES: Record<string, { read: string, write: string, admin: string }> = {
  contents: {
    read: 'Clone and read code',
    write: 'Push code, and merge pull requests',
    admin: 'Push code, and merge pull requests',
  },
  issues: {
    read: 'Read issues',
    write: 'Open, comment on, label and close issues',
    admin: 'Open, comment on, label and close issues',
  },
  pull_requests: {
    read: 'Read pull requests and reviews',
    write: 'Open pull requests, review them, and dismiss reviews',
    admin: 'Open pull requests, review them, and dismiss reviews',
  },
  webhooks: {
    read: 'Read webhook configuration',
    write: 'Add, change and remove webhooks',
    admin: 'Add, change and remove webhooks',
  },
  checks: {
    read: 'Read check results',
    write: 'Report check results and coverage',
    admin: 'Report check results and coverage',
  },
  administration: {
    read: 'Read repository settings',
    write: 'Change repository settings and branch protection',
    admin: 'Manage collaborators, and delete or transfer the repository',
  },
  members: {
    read: 'Read the member list',
    write: 'Invite and remove members',
    admin: 'Invite and remove members',
  },
  organization_administration: {
    read: 'Read organization settings',
    write: 'Change organization settings',
    admin: 'Change organization settings',
  },
  billing: {
    read: 'Read billing',
    write: 'Change billing',
    admin: 'Change billing',
  },
}

/** One grant, said out loud. */
export function describeGrant(grant: TokenGrant): string {
  const sentences = SCOPE_SENTENCES[grant.scope as string]

  // An unknown scope is described as itself rather than dropped. A token from a
  // newer instance should read as "something this build does not recognise",
  // which is a reason to look, not a blank row.
  if (!sentences)
    return `${String(grant.scope).replace(/_/g, ' ')} (${grant.level})`

  return sentences[grant.level as TokenLevel] ?? sentences.read
}

/** A token as the settings page shows it. */
export interface TokenListing {
  id: number
  name: string
  masked: string
  state: 'active' | 'expired' | 'revoked'
  /** One sentence per grant, in the words of the permission checks. */
  abilities: string[]
  /** What the token can reach, said as a phrase rather than a count. */
  reach: string
  /** The repositories it is scoped to, when it is scoped to repositories. */
  repositories: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  lastUsedIp: string | null
  neverUsed: boolean
  createdAt: string | null
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

function parseTime(value: unknown): number | null {
  const raw = text(value)
  if (raw === null)
    return null

  const parsed = Date.parse(raw)

  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Every token this account holds, newest first, ready to render.
 *
 * Revoked tokens are kept in the list rather than hidden. Somebody who has just
 * revoked something wants to see that it happened, and an audit of what an
 * account has ever issued is not an audit if it only shows what still works.
 */
export async function tokensFor(userId: number, nowMs = Date.now()): Promise<TokenListing[]> {
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
    .where('user_id', '=', userId)
    .execute()

  const listings = await Promise.all(rows.map(async (row: any): Promise<TokenListing> => {
    const id = Number(row.id)

    const permissions = await db
      .selectFrom('access_token_permissions')
      .select(['scope', 'level'])
      .where('access_token_id', '=', id)
      .execute()

    const grants = permissions.map((permission: any) => ({
      scope: String(permission.scope) as TokenScope,
      level: String(permission.level) as TokenLevel,
    }))

    const selection = String(row.selection ?? 'selected')

    let repositories: string[] = []
    let reach: string

    if (selection === 'all') {
      // The grant people pick by accident, so it says what it means. "Every
      // repository" reads as a fact about today; the point is that it silently
      // includes whatever the account gains next month.
      reach = 'Every repository this account can reach, including ones it has not been given yet'
    }
    else if (selection === 'organization') {
      const organization: any = await db
        .selectFrom('organizations')
        .select(['handle'])
        .where('id', '=', Number(row.organization_id ?? 0))
        .executeTakeFirst()

      reach = organization
        ? `Every repository in ${String(organization.handle)}`
        : 'An organization that no longer exists'
    }
    else {
      // Joined by hand rather than eagerly, because the id list is the thing
      // being displayed and a name that has since changed should show as it is
      // now. A repository that was deleted simply drops out, which is correct:
      // the token cannot reach it either.
      const scoped = await db
        .selectFrom('access_token_repositories')
        .innerJoin('repositories', 'repositories.id', '=', 'access_token_repositories.repository_id')
        .select(['repositories.name as name'])
        .where('access_token_repositories.access_token_id', '=', id)
        .execute()

      repositories = scoped.map((entry: any) => String(entry.name))

      reach = repositories.length === 0
        ? 'Nothing. Every repository it was scoped to has been deleted'
        : `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`
    }

    return {
      id,
      name: String(row.name),
      masked: maskToken(String(row.prefix)),
      state: tokenState({
        expiresAtMs: parseTime(row.expires_at),
        revokedAtMs: parseTime(row.revoked_at),
      }, nowMs),
      abilities: grants.map(describeGrant),
      reach,
      repositories,
      expiresAt: text(row.expires_at),
      lastUsedAt: text(row.last_used_at),
      lastUsedIp: text(row.last_used_ip),
      neverUsed: !row.last_used_at,
      createdAt: text(row.created_at),
    }
  }))

  // Newest first, and a token with no created_at sorts last rather than
  // throwing the order away.
  return listings.sort((a, b) => (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0))
}

/**
 * The repositories an account may scope a token to.
 *
 * The same set `CreateTokenAction` filters against, read once for the form so
 * somebody cannot pick a repository the endpoint is going to drop. Owned and
 * collaborating only: an organization's repositories are reachable through the
 * organization selection, which is the honest way to express that.
 */
export async function scopableRepositories(userId: number): Promise<{ id: number, name: string }[]> {
  const owned = await db
    .selectFrom('repositories')
    .select(['id', 'name'])
    .where('owner_type', '=', 'user')
    .where('owner_id', '=', userId)
    .execute()

  const collaborating = await db
    .selectFrom('repo_collaborators')
    .innerJoin('repositories', 'repositories.id', '=', 'repo_collaborators.repository_id')
    .select(['repositories.id as id', 'repositories.name as name'])
    .where('repo_collaborators.user_id', '=', userId)
    .execute()

  const seen = new Set<number>()
  const all: { id: number, name: string }[] = []

  for (const row of [...owned, ...collaborating] as any[]) {
    const id = Number(row.id)
    if (seen.has(id))
      continue

    seen.add(id)
    all.push({ id, name: String(row.name) })
  }

  return all.sort((a, b) => a.name.localeCompare(b.name))
}
