/**
 * Resolving a repository for a page, and deciding whether the reader may see it.
 *
 * Every repository-scoped view needs the same two answers and had been working
 * them out separately. Four of them wrote out the owner-resolution dance by
 * hand - look the handle up in `organizations`, then in `users`, then match on
 * `owner_type`, `owner_id` and `name` - and two skipped the owner entirely and
 * matched on the name alone, which finds another owner's repository.
 *
 * None of them checked visibility. A private repository's pull requests, issues
 * and code all rendered to anyone who knew the URL, which is the failure the
 * JSON API's `authorizeRepository` exists to prevent; the pages simply did not
 * go through it, because it needs a `request` and an stx server script has none.
 *
 * So this is that function for pages: the same permission primitives, reading
 * the viewer from cookies instead of from a request.
 *
 * **Never throws.** A view that throws renders with every variable undefined
 * and reports nothing, so a signed-out visitor must come back as "no such
 * repository" rather than as a blank page.
 */

import type { GitRepositoryRow, RepositoryGrants } from '../Git/access'
import type { RepositoryAbility } from '../../Permissions'
import { canOnRepository } from '../../Permissions'
import { findRepositoryByPath, permissionOn } from '../Git/access'
import { viewerFromCookies } from '../Identity/lookup'

/** The parts of a repository row the decision depends on. */
export type RepositoryAccessFacts = Pick<GitRepositoryRow, 'visibility' | 'owner_type' | 'owner_id'>

export interface ViewAccess {
  /** Whether the reader may see the repository at all. */
  readable: boolean
  can: (ability: RepositoryAbility) => boolean
}

/**
 * What a reader may do with a repository.
 *
 * Pure, and separated from the queries around it so the rule can be tested
 * without a database. The rule itself is the same `canOnRepository` the JSON API
 * uses; what is worth pinning here is that a page asks it at all, and that it
 * asks about *reading* before it renders anything.
 */
export function repositoryViewAccess(
  repository: RepositoryAccessFacts,
  viewerId: number | null,
  grants: RepositoryGrants,
): ViewAccess {
  const input = {
    userId: viewerId,
    visibility: repository.visibility,
    // Personal repositories are owned by a user; an organization's are governed
    // by the member's role instead, so the owner id must not be read as a user.
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }

  return {
    readable: canOnRepository(input, 'repository:read'),
    can: (ability: RepositoryAbility) => canOnRepository(input, ability),
  }
}

export interface ViewerRow {
  id: number
  handle: string
  is_admin: boolean
}

export interface RepositoryForView {
  repository: GitRepositoryRow
  viewer: ViewerRow | null
  /** Whether the reader may do something beyond reading. */
  can: (ability: RepositoryAbility) => boolean
}

/**
 * The repository a page is about, or null.
 *
 * Null covers both "there is no such repository" and "you may not see this
 * one", deliberately and identically. Distinguishing them tells a stranger that
 * a private repository exists, which is the one thing it must not tell them.
 */
export async function repositoryForView(
  owner: unknown,
  name: unknown,
  cookies?: Record<string, string> | undefined | null,
): Promise<RepositoryForView | null> {
  const ownerHandle = String(owner ?? '').trim().toLowerCase()
  const repositoryName = String(name ?? '').trim()

  if (ownerHandle === '' || repositoryName === '')
    return null

  try {
    const repository = await findRepositoryByPath(ownerHandle, repositoryName)
    if (!repository)
      return null

    const viewer = await viewerFromCookies(cookies)
    const grants = await permissionOn(repository, viewer?.id ?? null)
    const access = repositoryViewAccess(repository, viewer?.id ?? null, grants)

    if (!access.readable)
      return null

    return { repository, viewer, can: access.can }
  }
  catch {
    return null
  }
}
