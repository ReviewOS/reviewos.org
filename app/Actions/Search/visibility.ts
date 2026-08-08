/**
 * Which of these results is this reader allowed to see.
 *
 * **The index is not a permission boundary and is never treated as one.** Every
 * repository goes in, private ones included, because an index that only holds
 * public rows cannot serve the search a signed-in maintainer actually wants -
 * their own work. What keeps that safe is that nothing here believes a document
 * about who may read it.
 *
 * The tempting shortcut is to stamp `visibility` on each document and add
 * `filter_by: visibility:=public` for anonymous readers. That is wrong in a way
 * that does not show up in testing: the index is a copy, and a copy goes stale.
 * A repository flipped from public to private is public in Typesense until a
 * job catches up, and the window between those two facts is exactly when
 * somebody is looking. Worse, the filter is a query parameter - one caller that
 * forgets it, one endpoint that builds its own query, and the whole thing is
 * open, with no error anywhere.
 *
 * So the index is treated as a *candidate generator* and nothing more. It says
 * which repositories might match; the database says which the reader may see,
 * through the same `canOnRepository` that guards the wire protocol and the
 * browse pages. There is one answer to "may this person read this repository"
 * in this codebase, and search asks it rather than approximating it.
 *
 * The cost is a query per result page. That is the correct thing to spend: it
 * is bounded by the page size, it is the same read the repository page does
 * anyway, and the alternative is a leak nobody notices until it is a report.
 */

import type { RepositoryVisibility } from '../../Permissions'
import { db } from '@stacksjs/database'
import { canOnRepository } from '../../Permissions'
import { permissionOn } from '../Git/access'

/** A repository as the permission check needs it, however it was found. */
export interface SearchableRepository {
  id: number
  owner_type: 'user' | 'organization'
  owner_id: number
  visibility: RepositoryVisibility
}

/**
 * The repositories, of these, that this reader may read.
 *
 * Ids in, ids out, in one pass. Takes the whole page rather than one row at a
 * time so the caller cannot accidentally write a loop that checks the first
 * result and renders the rest.
 *
 * An anonymous reader is `null`, not a sentinel user id. `canOnRepository`
 * already refuses everything but reading a public repository for `null`, and
 * inventing a "guest" row here would mean two places deciding what a stranger
 * can do.
 */
export async function readableRepositoryIds(
  candidateIds: readonly number[],
  viewerId: number | null,
): Promise<Set<number>> {
  const allowed = new Set<number>()

  const ids = [...new Set(candidateIds)].filter(id => Number.isInteger(id) && id > 0)
  if (ids.length === 0)
    return allowed

  // Read the rows the index claimed exist. A document whose repository has been
  // deleted simply drops out here, which is right: the index is a copy and this
  // is the authority.
  const rows = await db
    .selectFrom('repositories')
    .select(['id', 'owner_type', 'owner_id', 'visibility'])
    .where('id', 'in', ids)
    .execute()

  for (const row of rows as any[]) {
    const repository: SearchableRepository = {
      id: Number(row.id),
      owner_type: String(row.owner_type) as 'user' | 'organization',
      owner_id: Number(row.owner_id),
      visibility: String(row.visibility) as RepositoryVisibility,
    }

    if (await mayRead(repository, viewerId))
      allowed.add(repository.id)
  }

  return allowed
}

/**
 * Whether one reader may read one repository.
 *
 * A thin wrapper over the same check the git transport and the browse pages
 * use, and thin on purpose: the moment search has its own opinion about
 * visibility, the two drift and only one of them is audited.
 */
export async function mayRead(
  repository: SearchableRepository,
  viewerId: number | null,
): Promise<boolean> {
  // Public is public, and answering it without a query keeps the common case
  // off the database. This is the *only* shortcut taken here, and it is safe
  // because it can only ever widen to something already world-readable.
  if (repository.visibility === 'public')
    return true

  if (viewerId === null)
    return false

  const grants = await permissionOn(repository as any, viewerId)

  return canOnRepository({
    userId: viewerId,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }, 'repository:read')
}

/**
 * Drop from a page of hits anything the reader may not see.
 *
 * Order is preserved, because the ranking is the search engine's job and this
 * has no business reordering it - it only removes.
 *
 * **Filtered, not refused.** A page that contained one unreadable row returns
 * the rest rather than an error: the reader is not doing anything wrong, and a
 * 403 would itself confirm that something matching their query exists.
 */
export async function filterToReadable<T>(
  hits: readonly T[],
  repositoryIdOf: (hit: T) => number,
  viewerId: number | null,
): Promise<T[]> {
  if (hits.length === 0)
    return []

  const allowed = await readableRepositoryIds(hits.map(repositoryIdOf), viewerId)

  return hits.filter(hit => allowed.has(repositoryIdOf(hit)))
}
