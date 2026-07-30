/**
 * Resolving `{owner}/{repo}` from a request and deciding what the caller may do
 * with it.
 *
 * Every action below the repository level starts the same way: find the
 * repository, find the caller, work out whether the two are allowed to meet.
 * Written once here so a new action cannot accidentally skip the visibility
 * check, which is the mistake that leaks a private repository.
 */

import type { RepositoryAbility } from '../../Permissions'
import type { GitRepositoryRow } from '../Git/access'
import { canOnRepository, repositoryPermissionFor } from '../../Permissions'
import { findRepositoryByPath, permissionOn } from '../Git/access'
import { currentUser } from '../Identity/lookup'

export interface RepositoryContext {
  repository: GitRepositoryRow
  user: { id: number, handle: string, is_admin: boolean } | null
  /** The combined permission, or null when the caller cannot see it at all. */
  permission: ReturnType<typeof repositoryPermissionFor>
  can: (ability: RepositoryAbility) => boolean
}

export type AuthorizeResult =
  | { ok: true, context: RepositoryContext }
  | { ok: false, error: string, status: number }

/**
 * Load the repository named by the request and the caller's standing on it.
 *
 * A repository the caller may not read is reported as missing rather than
 * forbidden: "you are not allowed to see this" confirms it exists, which is the
 * one thing a private repository must not tell a stranger.
 */
export async function authorizeRepository(request: any, ability: RepositoryAbility): Promise<AuthorizeResult> {
  const owner = String(request.get('owner') ?? '').trim().toLowerCase()
  const name = String(request.get('repo') ?? request.get('repository') ?? '').trim()

  if (!owner || !name)
    return { ok: false, error: 'Repository not found', status: 404 }

  const repository = await findRepositoryByPath(owner, name)
  if (!repository)
    return { ok: false, error: 'Repository not found', status: 404 }

  const user = await currentUser(request)
  const grants = await permissionOn(repository, user?.id ?? null)

  const input = {
    userId: user?.id ?? null,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }

  if (!canOnRepository(input, 'repository:read'))
    return { ok: false, error: 'Repository not found', status: 404 }

  if (!canOnRepository(input, ability))
    return { ok: false, error: user ? 'Forbidden' : 'Unauthenticated', status: user ? 403 : 401 }

  return {
    ok: true,
    context: {
      repository,
      user: user ?? null,
      permission: repositoryPermissionFor(input),
      can: (candidate: RepositoryAbility) => canOnRepository(input, candidate),
    },
  }
}

/**
 * The next issue or pull request number for a repository.
 *
 * Issues and pull requests share one sequence, because `#12` has to mean one
 * thing. The counter lives on the repository row and is bumped by a conditional
 * update, so two requests arriving together cannot be handed the same number:
 * whichever loses the race sees a different current value and retries.
 */
export async function allocateNumber(repositoryId: number, attempts = 5): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await db
      .selectFrom('repositories')
      .select(['issue_counter'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    const current = Number(row?.issue_counter ?? 0)
    const next = current + 1

    const updated = await db
      .updateTable('repositories')
      .set({ issue_counter: next })
      .where('id', '=', repositoryId)
      .where('issue_counter', '=', current)
      .executeTakeFirst()

    if (Number(updated?.numUpdatedRows ?? 0) > 0)
      return next
  }

  throw new Error('Could not allocate a number for this repository')
}
