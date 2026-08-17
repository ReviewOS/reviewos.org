/**
 * Following a handle that has moved.
 *
 * Handles are first come, first served and live in one namespace: `/{handle}`
 * is a user or an organization, and whoever claimed the name has it. An alias
 * is the escape hatch for a name that stopped being the right one while the
 * links to it kept working - see `app/Models/OwnerAlias.ts` for why it both
 * redirects and reserves.
 *
 * This is only consulted on a miss. A real user or organization always wins,
 * so an alias can never shadow a live account, and the common path costs
 * nothing: the query only runs when the page was going to 404 anyway.
 */

/** Where a taken-but-moved handle should send the reader, or nothing. */
export async function aliasTarget(handle: string): Promise<string | null> {
  const wanted = String(handle ?? '').trim().toLowerCase()

  if (!wanted)
    return null

  try {
    const db = (globalThis as any).db

    const alias: any = await db
      .selectFrom('owner_aliases')
      .select(['owner_type', 'owner_id'])
      .where('handle', '=', wanted)
      .executeTakeFirst()

    if (!alias)
      return null

    const table = alias.owner_type === 'organization' ? 'organizations' : 'users'

    const owner: any = await db
      .selectFrom(table)
      .select(['handle'])
      .where('id', '=', Number(alias.owner_id))
      .executeTakeFirst()

    // An alias whose owner has been deleted is a dangling row, and the honest
    // answer is the 404 the caller was already going to render.
    return owner?.handle ? String(owner.handle) : null
  }
  catch {
    // Never throws: this runs while rendering, and a page that fails to render
    // is worse than a page that renders its not-found.
    return null
  }
}

/**
 * The same path with the owner segment replaced.
 *
 * The rest of the path is carried through deliberately: somebody following a
 * years-old link to `/stacksjs/stacks/issues/4` wants issue 4, not a profile
 * page. A redirect that drops everything after the handle is a redirect that
 * loses the reason the link was clicked.
 */
export function pathUnderOwner(path: string, canonical: string): string {
  const [withoutQuery, query] = String(path ?? '/').split('?')
  const segments = withoutQuery.split('/').filter(Boolean)

  segments[0] = canonical

  return `/${segments.join('/')}${query ? `?${query}` : ''}`
}
