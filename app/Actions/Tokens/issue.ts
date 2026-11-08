import type { ResourceSelection, TokenGrant } from '../../TokenScopes'
import { db } from '@stacksjs/database'
import { normalizeGrants, resolveExpiry } from '../../TokenScopes'
import { recordTokenAudit } from './audit'
import { generateToken } from './secret'

/**
 * Issuing and revoking an access token, once, for every way in.
 *
 * The settings page and the API reach this through `CreateTokenAction` and
 * `RevokeTokenAction`; an operator at the instance's shell reaches it through
 * `buddy token:create` and `buddy token:revoke`. Before the commands existed,
 * automation that needed a token (HQ's CI cancelling superseded runs) inserted
 * rows into `access_tokens` by hand: no permission check on the repositories,
 * no audit line, and a hand-rolled copy of the token format. One function means
 * the rules - a name, at least one known grant, an expiry inside the instance's
 * ceiling, repositories the owner can actually read - are the same rules
 * whichever door the request came through.
 */

export const TOKEN_SELECTIONS = ['all', 'organization', 'selected'] as const

export interface IssueTokenInput {
  /** The account the token acts as. */
  userId: number
  name: string
  selection: string
  /** Required for `organization`, ignored otherwise. */
  organizationId?: number | null
  /** Asked for; filtered to the ones the owner can read. Required for `selected`. */
  repositoryIds?: readonly unknown[]
  /** Asked for; unknown scopes and levels are dropped by `normalizeGrants`. */
  permissions: readonly { scope: string, level: string }[]
  /** Epoch milliseconds, or null for the instance default. */
  expiresAtMs?: number | null
  /** Hourly creation budgets, already read. Absent means the instance default. */
  limits?: Record<string, number>
  /** Who issued it, when that is not the owner (an operator at the shell). Null for nobody. */
  actorId?: number | null
  /** Recorded on the audit line when the issuer is not an account: `cli:root@host`. */
  externalActor?: string | null
  /** Extra audit detail, such as `replaces` on a rotation. */
  detail?: Record<string, unknown>
  /** Clock, for tests. */
  nowMs?: number
}

export interface IssuedAccessToken {
  id: number
  name: string
  /** The secret, in full. The only time it exists outside its holder. */
  token: string
  prefix: string
  selection: ResourceSelection
  organization_id: number | null
  repository_ids: number[]
  permissions: TokenGrant[]
  expires_at: string
}

export type IssueTokenResult
  = | { ok: true, token: IssuedAccessToken }
    | { ok: false, status: 422, error: string }

/** Issue a token: validate, store its hash and grants, audit it, and hand the secret back once. */
export async function issueAccessToken(input: IssueTokenInput): Promise<IssueTokenResult> {
  const refuse = (error: string): IssueTokenResult => ({ ok: false, status: 422, error })

  const name = String(input.name ?? '').trim()
  if (!name)
    return refuse('A token needs a name, so it can be recognised later')

  const selection = String(input.selection ?? 'selected')
  if (!(TOKEN_SELECTIONS as readonly string[]).includes(selection))
    return refuse('A selection is all, organization, or selected')

  const grants = normalizeGrants(input.permissions ?? [])
  if (grants.length === 0)
    return refuse('A token with no permissions can do nothing')

  const requestedExpiry = input.expiresAtMs ?? null
  if (requestedExpiry !== null && !Number.isFinite(requestedExpiry))
    return refuse('An expiry has to be a date')

  const expiry = resolveExpiry(requestedExpiry, input.nowMs ?? Date.now())
  if (!expiry.ok)
    return refuse(expiry.error)

  let organizationId: number | null = null
  if (selection === 'organization') {
    organizationId = Number(input.organizationId)
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return refuse('An organization is required for that selection')

    // A token cannot reach an organization its owner does not belong to. The
    // per-request check would catch this later anyway; refusing at issue time
    // means nobody walks away holding a token that silently does nothing.
    const membership = await db
      .selectFrom('org_members')
      .select(['id'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst()

    if (!membership)
      return refuse('You are not a member of that organization')
  }

  const repositoryIds = selection === 'selected'
    ? await readableRepositories(input.repositoryIds ?? [], input.userId)
    : []

  if (selection === 'selected' && repositoryIds.length === 0)
    return refuse('Choose at least one repository you can reach')

  const issued = generateToken()
  const expiresAt = new Date(expiry.expiresAtMs).toISOString()

  const created = await db
    .insertInto('access_tokens')
    .values({
      user_id: input.userId,
      name,
      prefix: issued.prefix,
      token_hash: issued.hash,
      selection: selection as ResourceSelection,
      organization_id: organizationId,
      expires_at: expiresAt,
      ...(input.limits ?? {}),
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

  await recordTokenAudit({
    event: 'token:created',
    tokenId,
    ownerId: input.userId,
    prefix: issued.prefix,
    actorId: input.actorId,
    externalActor: input.externalActor ?? null,
    detail: {
      name,
      selection,
      organization_id: organizationId,
      repository_ids: repositoryIds,
      // What it was born able to do. Every later change is read against this
      // row, so it has to be the whole set rather than a count.
      permissions: grants.map(grant => `${grant.scope}:${grant.level}`).sort(),
      expires_at: expiresAt,
      ...input.detail,
    },
  })

  return {
    ok: true,
    token: {
      id: tokenId,
      name,
      token: issued.token,
      prefix: issued.prefix,
      selection: selection as ResourceSelection,
      organization_id: organizationId,
      repository_ids: repositoryIds,
      permissions: grants,
      expires_at: expiresAt,
    },
  }
}

export interface RevokeTokenInput {
  id: number
  ownerId: number
  prefix: string | null
  /** The account that revoked it, or null for an operator at the shell. */
  actorId: number | null
  externalActor?: string | null
  reason?: string | null
  detail?: Record<string, unknown>
}

/**
 * Revoke a token and say so in the audit log.
 *
 * The row is kept with `revoked_at` set, so "which token did this, and when was
 * it stopped" still has an answer. Guarded on `revoked_at` being empty, so two
 * revocations at once record one revocation; the answer says which happened.
 */
export async function revokeAccessToken(input: RevokeTokenInput): Promise<{ revokedAt: string, alreadyRevoked: boolean }> {
  const revokedAt = new Date().toISOString()

  const changed: any = await db
    .updateTable('access_tokens')
    .set({ revoked_at: revokedAt, revoked_by_id: input.actorId })
    .where('id', '=', input.id)
    .whereNull('revoked_at')
    .returning(['id'])
    .executeTakeFirst()

  if (!changed) {
    const row: any = await db.selectFrom('access_tokens').select(['revoked_at']).where('id', '=', input.id).executeTakeFirst()
    return { revokedAt: String(row?.revoked_at ?? revokedAt), alreadyRevoked: true }
  }

  await recordTokenAudit({
    event: 'token:revoked',
    tokenId: input.id,
    ownerId: input.ownerId,
    prefix: input.prefix,
    actorId: input.actorId,
    externalActor: input.externalActor ?? null,
    reason: input.reason ?? null,
    detail: input.detail,
  })

  return { revokedAt, alreadyRevoked: false }
}

/**
 * The requested repositories, filtered to the ones this user can actually read.
 *
 * Filtered rather than refused, so a stale id in a script does not fail the
 * whole request, and reported back so the caller can see what the token ended
 * up scoped to.
 */
export async function readableRepositories(requested: readonly unknown[], userId: number): Promise<number[]> {
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
