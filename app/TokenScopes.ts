/**
 * What a token is allowed to do.
 *
 * There is one kind of token here and it is fine-grained. The reason is written
 * out in the roadmap, but the short version is that GitHub's `packages:read`
 * cannot be granted by a fine-grained token, so anyone who needs it is issued a
 * classic token carrying every scope on the account across every repository.
 * The narrow path does not work, so the wide one gets used, and a permission
 * list with a hole in it becomes a security problem.
 *
 * The rule that prevents that here is mechanical rather than cultural: every
 * ability in `Permissions.ts` maps to a token scope and a level in this file,
 * and a test fails if one does not. Adding a capability without a way to grant
 * it to a token is a build failure, not a review comment.
 *
 * Scopes are deliberately coarser than abilities. A person setting up a token
 * thinks "let it read code and comment on pull requests", not in terms of
 * eighteen separate verbs, and a permission screen nobody can read gets
 * answered with "all of them".
 *
 * Pure, no database, same as `Permissions.ts`. A token grant is only ever an
 * upper bound: the effective answer is this AND what the user themselves can
 * do, which is why `effectiveCan` takes both.
 */

import type { OrganizationAbility, RepositoryAbility } from './Permissions'

export const TOKEN_LEVELS = ['read', 'write', 'admin'] as const
export type TokenLevel = typeof TOKEN_LEVELS[number]

export const REPOSITORY_SCOPES = [
  'contents',
  'issues',
  'pull_requests',
  'webhooks',
  'administration',
] as const
export type RepositoryScope = typeof REPOSITORY_SCOPES[number]

export const ORGANIZATION_SCOPES = [
  'members',
  'organization_administration',
  'billing',
] as const
export type OrganizationScope = typeof ORGANIZATION_SCOPES[number]

export type TokenScope = RepositoryScope | OrganizationScope

export interface TokenRequirement<Scope extends TokenScope> {
  scope: Scope
  level: TokenLevel
}

/**
 * What each repository ability needs from a token.
 *
 * `pull:merge` sits under `contents` rather than `pull_requests` because
 * merging moves a branch. A token that may open and review pull requests but
 * not write code should not be able to land one.
 */
export const REPOSITORY_ABILITY_SCOPES = {
  'repository:read': { scope: 'contents', level: 'read' },
  'repository:push': { scope: 'contents', level: 'write' },
  'pull:merge': { scope: 'contents', level: 'write' },

  'issue:open': { scope: 'issues', level: 'write' },
  'issue:comment': { scope: 'issues', level: 'write' },
  'issue:label': { scope: 'issues', level: 'write' },
  'issue:assign': { scope: 'issues', level: 'write' },
  'issue:milestone': { scope: 'issues', level: 'write' },
  'issue:close': { scope: 'issues', level: 'write' },
  'issue:lock': { scope: 'issues', level: 'write' },
  'issue:edit-any': { scope: 'issues', level: 'write' },

  'pull:open': { scope: 'pull_requests', level: 'write' },
  'pull:review': { scope: 'pull_requests', level: 'write' },
  'pull:close': { scope: 'pull_requests', level: 'write' },
  'pull:request-review': { scope: 'pull_requests', level: 'write' },
  'pull:edit-any': { scope: 'pull_requests', level: 'write' },
  'pull:dismiss-review': { scope: 'pull_requests', level: 'write' },

  'webhook:manage': { scope: 'webhooks', level: 'write' },

  'repository:settings': { scope: 'administration', level: 'write' },
  'branch:protect': { scope: 'administration', level: 'write' },
  'collaborator:manage': { scope: 'administration', level: 'admin' },
  'repository:delete': { scope: 'administration', level: 'admin' },
  'repository:transfer': { scope: 'administration', level: 'admin' },
} as const satisfies Record<RepositoryAbility, TokenRequirement<RepositoryScope>>

/** What each organization ability needs from a token. */
export const ORGANIZATION_ABILITY_SCOPES = {
  'members:view': { scope: 'members', level: 'read' },
  'teams:view': { scope: 'members', level: 'read' },
  'members:manage': { scope: 'members', level: 'write' },
  'teams:manage': { scope: 'members', level: 'write' },

  'repositories:create': { scope: 'organization_administration', level: 'write' },
  'settings:manage': { scope: 'organization_administration', level: 'admin' },
  'organization:delete': { scope: 'organization_administration', level: 'admin' },

  'billing:manage': { scope: 'billing', level: 'admin' },
} as const satisfies Record<OrganizationAbility, TokenRequirement<OrganizationScope>>

/** One granted permission, as it is stored: one row, not a bit in a field. */
export interface TokenGrant {
  scope: TokenScope
  level: TokenLevel
}

function levelRank(level: TokenLevel): number {
  return TOKEN_LEVELS.indexOf(level)
}

/** Whether a held level covers a required one. */
export function levelSatisfies(held: TokenLevel | null, required: TokenLevel): boolean {
  if (!held)
    return false

  return levelRank(held) >= levelRank(required)
}

/**
 * The level a set of grants holds on a scope.
 *
 * The most permissive wins if a scope somehow appears twice, matching how
 * repository permissions combine. Access widens as grants are added, never
 * narrows, which is the only rule that stays understandable.
 */
export function levelFor(grants: readonly TokenGrant[], scope: TokenScope): TokenLevel | null {
  let held: TokenLevel | null = null

  for (const grant of grants) {
    if (grant.scope !== scope)
      continue

    if (held === null || levelRank(grant.level) > levelRank(held))
      held = grant.level
  }

  return held
}

/** Whether a token's grants permit a repository ability. */
export function tokenAllows(grants: readonly TokenGrant[], ability: RepositoryAbility): boolean {
  const required = REPOSITORY_ABILITY_SCOPES[ability]

  return levelSatisfies(levelFor(grants, required.scope), required.level)
}

/** Whether a token's grants permit an organization ability. */
export function tokenAllowsInOrganization(
  grants: readonly TokenGrant[],
  ability: OrganizationAbility,
): boolean {
  const required = ORGANIZATION_ABILITY_SCOPES[ability]

  return levelSatisfies(levelFor(grants, required.scope), required.level)
}

/**
 * The answer that actually decides a request.
 *
 * A grant is an upper bound on what the user could already do, never a
 * widening. Recomputed per request rather than baked in at issue time, so
 * removing somebody from a repository revokes their token's reach into it
 * without anybody having to remember to revoke the token.
 */
export function effectiveCan(input: {
  grants: readonly TokenGrant[]
  userCan: boolean
}, ability: RepositoryAbility): boolean {
  return input.userCan && tokenAllows(input.grants, ability)
}

/** Which repositories a token can see at all. */
export type ResourceSelection = 'all' | 'organization' | 'selected'

export interface TokenReach {
  selection: ResourceSelection
  /** Set when the selection is `organization`. */
  organizationId?: number | null
  /** Set when the selection is `selected`. */
  repositoryIds?: readonly number[]
}

/**
 * Whether a token reaches a repository at all, before any ability is asked.
 *
 * Checked first and separately, because "this token cannot see that repository"
 * and "this token lacks that permission" are different answers, and conflating
 * them is how a debugging session becomes an afternoon.
 */
export function tokenReaches(
  reach: TokenReach,
  repository: { id: number, owner_type: 'user' | 'organization', owner_id: number },
): boolean {
  switch (reach.selection) {
    case 'all':
      return true
    case 'organization':
      return repository.owner_type === 'organization'
        && Number(reach.organizationId ?? 0) === repository.owner_id
    case 'selected':
      return (reach.repositoryIds ?? []).includes(repository.id)
    default:
      return false
  }
}

export type TokenState = 'active' | 'expired' | 'revoked'

/**
 * Whether a token is usable, and if not, why.
 *
 * Revoked is checked before expired: a token that was revoked and has since
 * passed its expiry should still report as revoked, because that is the fact
 * somebody reading an audit log needs.
 */
export function tokenState(
  token: { expiresAtMs: number | null, revokedAtMs: number | null },
  nowMs: number,
): TokenState {
  if (token.revokedAtMs !== null && token.revokedAtMs <= nowMs)
    return 'revoked'

  if (token.expiresAtMs !== null && token.expiresAtMs <= nowMs)
    return 'expired'

  return 'active'
}

/** Ninety days, in milliseconds. The default life of a token. */
export const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

/** One year. An instance may lower this; nothing may raise it. */
export const MAXIMUM_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Validate a requested expiry.
 *
 * There is no unlimited option, deliberately. The cost of that decision is that
 * tokens expire in CI at inconvenient moments, which is why the roadmap pairs
 * this with warning somebody before it happens: an expiry people are ambushed
 * by is an expiry they will find a way to avoid setting.
 */
export type ExpiryOutcome =
  | { ok: true, expiresAtMs: number }
  | { ok: false, error: string }

export function resolveExpiry(
  requestedMs: number | null,
  nowMs: number,
  maximumMs: number = MAXIMUM_TOKEN_LIFETIME_MS,
): ExpiryOutcome {
  const expiresAtMs = requestedMs ?? nowMs + DEFAULT_TOKEN_LIFETIME_MS

  if (expiresAtMs <= nowMs)
    return { ok: false, error: 'A token has to expire in the future' }

  if (expiresAtMs > nowMs + maximumMs)
    return { ok: false, error: 'A token cannot last longer than this instance allows' }

  return { ok: true, expiresAtMs }
}

/**
 * Reduce a requested set of grants to the ones this instance recognises.
 *
 * Unknown scopes are dropped rather than refused, so a client built against a
 * newer version asking for a scope this instance has never heard of still gets
 * a working token with less in it, and can tell what it got from the response.
 */
export function normalizeGrants(
  requested: readonly { scope: string, level: string }[],
): TokenGrant[] {
  const known = new Set<string>([...REPOSITORY_SCOPES, ...ORGANIZATION_SCOPES])
  const byScope = new Map<TokenScope, TokenLevel>()

  for (const grant of requested) {
    if (!known.has(grant.scope))
      continue

    if (!(TOKEN_LEVELS as readonly string[]).includes(grant.level))
      continue

    const scope = grant.scope as TokenScope
    const level = grant.level as TokenLevel
    const held = byScope.get(scope)

    if (held === undefined || levelRank(level) > levelRank(held))
      byScope.set(scope, level)
  }

  return [...byScope.entries()]
    .map(([scope, level]) => ({ scope, level }))
    .sort((a, b) => a.scope.localeCompare(b.scope))
}
