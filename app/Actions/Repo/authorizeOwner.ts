/**
 * Every repository under one owner that this caller may read.
 *
 * The question an owner-wide answer needs and `authorizeRepository` cannot ask:
 * that one resolves the caller *and* one named repository together, which is
 * right for an endpoint about a repository and useless for a rollup across
 * forty of them.
 *
 * **The rules are not restated here.** The caller is resolved once - a
 * fine-grained token, or a session - and then every repository under the owner
 * goes through the same `canOnRepository`, the same `tokenReaches`, the same
 * `tokenAllows` that a single-repository request would go through. A repository
 * this returns is one `authorizeRepository` would have allowed, and a
 * repository it drops is one that would have answered 404. Two implementations
 * of a visibility boundary is the boundary eventually leaking, and the leak is
 * somebody's private repository appearing in an aggregate.
 *
 * ## An aggregate is a disclosure
 *
 * That is the reason this is careful. "Forty-two runs, 61% passing" over
 * repositories a caller cannot see tells them those repositories exist, roughly
 * how busy they are, and whether they are healthy. So the set is filtered
 * before anything is counted, and a caller who can see nothing gets an answer
 * about nothing rather than an error - the same shape, so nothing is inferable
 * from which response arrived.
 */

import type { RepositoryAbility } from '../../Permissions'
import { canOnRepository } from '../../Permissions'
import { db } from '@stacksjs/database'
import { fineGrainedToken } from './authorize'
import { permissionOn } from '../Git/access'
import { currentUser } from '../Identity/lookup'
import { tokenAllows, tokenReaches } from '../../TokenScopes'

export interface OwnerScope {
  ok: boolean
  /** The repositories the caller may exercise the ability on. Possibly empty. */
  repositoryIds: number[]
  /** The owner's row id, for anything that aggregates by owner. */
  ownerId: number
  error?: string
  status?: number
}

/**
 * The owner's repositories this caller may do `ability` on.
 *
 * `ok: true` with an empty list is a real answer: an owner exists and this
 * caller can see none of their repositories. It is deliberately not a 404,
 * because a 404 for "an owner with nothing you can see" and a 404 for "no such
 * owner" would be two answers a caller can tell apart - and telling them apart
 * is how somebody enumerates private organizations.
 */
export async function authorizeOwnerRepositories(request: any, ability: RepositoryAbility): Promise<OwnerScope> {
  const handle = String(request.get('owner') ?? '').trim().toLowerCase()

  if (!handle)
    return { ok: false, repositoryIds: [], ownerId: 0, error: 'An owner is required', status: 422 }

  const owner = await ownerByHandle(handle)

  if (!owner)
    return { ok: true, repositoryIds: [], ownerId: 0 }

  const presented = await fineGrainedToken(request)

  if (presented === 'rejected')
    return { ok: false, repositoryIds: [], ownerId: 0, error: 'Unauthenticated', status: 401 }

  const token = presented

  const user = token
    ? await db.selectFrom('users').select(['id', 'handle', 'is_admin']).where('id', '=', token.userId).executeTakeFirst().catch(() => null)
    : await currentUser(request)

  /*
   * A token that does not carry the ability at all is refused once, here,
   * rather than silently returning nothing. "Your token cannot do this" and
   * "you can see no repositories" are different facts and a caller acts on
   * them differently - the first is a token to re-issue.
   */
  if (token && !tokenAllows(token.grants, ability))
    return { ok: false, repositoryIds: [], ownerId: Number(owner.id), error: `This token does not carry the ${ability} permission`, status: 403 }

  const repositories = await db
    .selectFrom('repositories')
    .select(['id', 'name', 'visibility', 'owner_type', 'owner_id'])
    .where('owner_type', '=', String(owner.type))
    .where('owner_id', '=', Number(owner.id))
    .limit(1000)
    .execute()
    .catch(() => [])

  const allowed: number[] = []

  for (const repository of repositories as any[]) {
    const grants = await permissionOn(repository, user?.id ?? null)

    const input = {
      userId: user?.id ?? null,
      visibility: repository.visibility,
      ownerUserId: String(repository.owner_type) === 'user' ? Number(repository.owner_id) : null,
      ...grants,
    }

    // Read first, then the ability, in that order - the same order the
    // single-repository path uses, so a repository invisible to this caller is
    // never reported as forbidden.
    if (!canOnRepository(input, 'repository:read'))
      continue

    if (token && !tokenReaches(token.reach, repository))
      continue

    if (!canOnRepository(input, ability))
      continue

    allowed.push(Number(repository.id))
  }

  return { ok: true, repositoryIds: allowed, ownerId: Number(owner.id) }
}

/** A user or an organization by handle, whichever has it. */
async function ownerByHandle(handle: string): Promise<{ id: number, type: 'user' | 'organization' } | null> {
  const user = await db
    .selectFrom('users')
    .select(['id'])
    .where('handle', '=', handle)
    .executeTakeFirst()
    .catch(() => null)

  if (user?.id)
    return { id: Number(user.id), type: 'user' }

  const organization = await db
    .selectFrom('organizations')
    .select(['id'])
    .where('handle', '=', handle)
    .executeTakeFirst()
    .catch(() => null)

  return organization?.id ? { id: Number(organization.id), type: 'organization' } : null
}
