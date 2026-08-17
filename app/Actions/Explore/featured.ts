/**
 * The repositories this instance puts its name behind.
 *
 * ## Curated, not computed
 *
 * `trending()` and `recentlyActive()` already answer "what is moving" and
 * "what is alive", and neither answers "what should somebody arriving for the
 * first time look at". On an instance whose repositories were bulk-mirrored on
 * one afternoon, both of those rank by accidents of the import: everything was
 * pushed at the same minute and nothing has gained a star yet. A landing page
 * driven off them would show a random dozen.
 *
 * So the front page list is written down. It is an editorial decision and it
 * is treated as one, the same way `resources/functions/marketing.ts` holds the
 * feature catalog rather than deriving it.
 *
 * ## Slugs here, facts from the database
 *
 * Only the `owner/name` is written. The description, the star count, the
 * language and the last push are read live, so a featured entry cannot drift
 * into advertising a description that changed a year ago.
 *
 * A slug that does not resolve is dropped rather than rendered as a broken
 * card, and so is a repository that is not public - which is the property that
 * makes this list safe to edit without checking visibility by hand. Fork this
 * instance and the list is one file to change; leave it empty and the section
 * does not render.
 */

export interface FeaturedRepository {
  owner: string
  name: string
  description: string | null
  stars: number
  language: string | null
  /** The editorial line, when the repository's own description is too terse. */
  note: string | null
}

/**
 * The list, in the order it is shown.
 *
 * Ordered deliberately rather than by stars: the first entry is the one that
 * explains what everything else is built on, which is not the same question as
 * which is most popular.
 */
export const FEATURED: readonly { slug: string, note: string | null }[] = [
  { slug: 'stacks/stacks', note: 'The full-stack TypeScript framework ReviewOS itself is built on.' },
  { slug: 'reviewos/reviewos.org', note: 'This forge, hosting itself. The review screen you are reading about, reviewing its own changes.' },
  { slug: 'stacks/bun-query-builder', note: 'The typed query builder behind every read on this page.' },
  { slug: 'stacks/stx', note: 'The templating engine rendering this page on the server.' },
  { slug: 'pantry-pm/pantry', note: 'The package manager that installs Postgres and git for a fresh checkout.' },
  { slug: 'stacks/bunpress', note: 'The documentation engine behind /docs.' },
]

/**
 * The featured list, hydrated.
 *
 * Never throws. This renders on the landing page, and a landing page that
 * fails to render because a database read failed is a worse outcome than a
 * landing page with one section missing - especially since the section is the
 * only part of that page that needs a database at all.
 */
export async function featured(): Promise<FeaturedRepository[]> {
  if (FEATURED.length === 0)
    return []

  try {
    const db = (globalThis as any).db

    /*
     * Repositories first, owners second, the same shape `explore.ts` uses.
     *
     * Not a join, and that is not a style choice: `bun-query-builder` cannot
     * express a join onto two owner tables keyed by one polymorphic column,
     * and it does not fail when asked - see the note in `docs/todo/index.md`
     * about it dropping what it cannot express. Three small queries that
     * return the right answer beat one that silently returns a subset.
     */
    const owners = [...new Set(FEATURED.map(entry => entry.slug.split('/')[0]))]
    const names = [...new Set(FEATURED.map(entry => entry.slug.split('/')[1]))]

    const rows: any[] = await db
      .selectFrom('repositories')
      .select(['name', 'description', 'stars_count', 'owner_type', 'owner_id'])
      .where('visibility', '=', 'public')
      .where('name', 'in', names)
      .execute()

    const handles = await ownerHandles(db, rows)
    const found = new Map<string, any>()

    for (const row of rows) {
      const owner = handles.get(`${row.owner_type}:${row.owner_id}`)

      if (owner && owners.includes(String(owner)))
        found.set(`${owner}/${row.name}`.toLowerCase(), { ...row, owner, stars: row.stars_count })
    }

    // Languages in one more query, keyed by the repositories we actually kept.
    const language = await primaryLanguages(db, [...found.values()].map(row => row.name))

    return FEATURED.flatMap((entry) => {
      const row = found.get(entry.slug.toLowerCase())

      // Not here, or not public. Dropped rather than rendered as a card that
      // links nowhere.
      if (!row)
        return []

      return [{
        owner: String(row.owner),
        name: String(row.name),
        description: row.description ?? null,
        stars: Number(row.stars ?? 0),
        language: language.get(String(row.name)) ?? null,
        note: entry.note,
      }]
    })
  }
  catch {
    return []
  }
}

/**
 * Handles for the rows we read, in two queries rather than one per row.
 *
 * Keyed `type:id` because `owner_id` is polymorphic: the same number is a
 * valid user id and a valid organization id, and reading one as the other is
 * how a featured card ends up linking to a stranger's profile.
 */
async function ownerHandles(db: any, repositories: readonly any[]): Promise<Map<string, string>> {
  const handles = new Map<string, string>()

  for (const [type, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
    const ids = [...new Set(repositories.filter(row => row.owner_type === type).map(row => Number(row.owner_id)))]

    if (ids.length === 0)
      continue

    try {
      const rows: any[] = await db.selectFrom(table).select(['id', 'handle']).where('id', 'in', ids).execute()

      for (const row of rows)
        handles.set(`${type}:${row.id}`, String(row.handle))
    }
    catch {
      // A card with no owner is not renderable, and the caller drops it rather
      // than showing a repository nobody can navigate to.
    }
  }

  return handles
}

/**
 * The most-used language per repository name.
 *
 * Best effort: a repository whose languages have not been scanned yet simply
 * has none, which renders as a card without a language chip rather than as an
 * error.
 */
async function primaryLanguages(db: any, names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()

  if (names.length === 0)
    return found

  try {
    const rows: any[] = await db
      .selectFrom('repository_languages')
      .innerJoin('repositories', 'repositories.id', 'repository_languages.repository_id')
      .select(['repositories.name as name', 'repository_languages.language as language', 'repository_languages.bytes as bytes'])
      .where('repositories.name', 'in', names)
      .orderBy('repository_languages.bytes', 'desc')
      .execute()

    for (const row of rows) {
      if (!found.has(String(row.name)))
        found.set(String(row.name), String(row.language))
    }
  }
  catch {
    // No scan yet, or the table is not there on a fresh instance.
  }

  return found
}
