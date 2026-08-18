import { db } from '@stacksjs/database'
/**
 * The handle a repository belongs to.
 *
 * `repositories.owner_id` is polymorphic - the same number is a valid user id
 * and a valid organization id - so reading one as the other hands back a
 * stranger's handle, and every path built from it points at somebody else's
 * storage. `owner_type` is what decides, and it is the whole of the logic
 * here; this exists so that decision is written once rather than in each
 * caller that needs a path.
 */

export interface OwnedRow {
  owner_type?: unknown
  owner_id?: unknown
}

/** The owner's handle, or null when the row points at an owner that is gone. */
export async function ownerHandleFor(repository: OwnedRow): Promise<string | null> {
  const id = Number(repository?.owner_id ?? 0)

  if (!id)
    return null

  const table = String(repository?.owner_type) === 'organization' ? 'organizations' : 'users'

  try {
    const owner = await db
      .selectFrom(table)
      .select(['handle'])
      .where('id', '=', id)
      .executeTakeFirst()

    return owner?.handle ? String(owner.handle) : null
  }
  catch {
    return null
  }
}
