import { db } from '@stacksjs/database'
import { portable } from '../Support/sql'
/**
 * The four questions an explore page answers.
 *
 * All four are reads over public repositories only, and that is enforced here
 * rather than by each caller: an explore page is the one surface where a
 * mistake is not a leak to one person but a listing.
 */

export interface ExploreRepository {
  owner: string
  name: string
  description: string | null
  stars: number
  language: string | null
  pushedAt: string | null
  /** Only on trending, where it is the point. */
  gained?: number
}

/** How many to return. Enough to fill a page, few enough to render at once. */
export const EXPLORE_LIMIT = 24

/**
 * Repositories gaining stars fastest over a window.
 *
 * **Gained rather than total**, which is the whole reason this is not just an
 * ordering of `stars_count`. A list by total stars is the same list every week
 * and shows nobody anything they did not know; the point of trending is that
 * new work can surface, and only a window can do that.
 *
 * The window is a parameter because the right one depends on the instance: a
 * week is right for a busy public instance and shows an empty page on a company
 * one, where a month is the smallest window with anything in it.
 */
export async function trending(days = 7, limit = EXPLORE_LIMIT): Promise<ExploreRepository[]> {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString()

  try {
    /*
     * Counted from the star rows rather than from a column, because a column
     * only knows the total. `stars.created_at` is what makes a window possible
     * at all, and it is the reason this table keeps one row per star rather
     * than a counter.
     */
    const rows: any[] = await db.unsafe(
      portable(`SELECT "r"."id", COUNT("s"."id") AS "gained"
      FROM "stars" "s"
      JOIN "repositories" "r" ON "r"."id" = "s"."repository_id"
      WHERE "s"."created_at" >= $1
        AND "r"."visibility" = 'public'
      GROUP BY "r"."id"
      ORDER BY "gained" DESC, "r"."id" DESC
      LIMIT $2`),
      [since, limit],
    ).execute()

    return await decorate(rows.map(row => ({ id: Number(row.id), gained: Number(row.gained) || 0 })))
  }
  catch (error) {
    console.error('[explore] trending failed:', error)

    return []
  }
}

/**
 * Repositories that have been pushed to lately.
 *
 * The most honest signal an instance has, and the one that needs no history:
 * `pushed_at` is written by the push path itself. On a young instance this is
 * the only explore list with anything in it, which is why it exists separately
 * from trending rather than as a fallback inside it - a page that silently
 * showed a different thing than its heading claims is worse than an empty
 * section.
 */
export async function recentlyActive(limit = EXPLORE_LIMIT): Promise<ExploreRepository[]> {

  try {
    const rows: any[] = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('visibility', '=', 'public')
      .whereNotNull('pushed_at')
      .orderBy('pushed_at', 'desc')
      .limit(limit)
      .execute()

    return await decorate(rows.map(row => ({ id: Number(row.id) })))
  }
  catch (error) {
    console.error('[explore] recently active failed:', error)

    return []
  }
}

/** Public repositories carrying a topic, most starred first. */
export async function byTopic(topic: string, limit = EXPLORE_LIMIT): Promise<ExploreRepository[]> {
  const wanted = String(topic ?? '').trim().toLowerCase()

  if (!wanted)
    return []

  try {
    const rows: any[] = await db
      .selectFrom('repo_topics')
      .innerJoin('repositories', 'repositories.id', '=', 'repo_topics.repository_id')
      .select(['repositories.id as id'])
      .where('repo_topics.topic', '=', wanted)
      .where('repositories.visibility', '=', 'public')
      .orderBy('repositories.stars_count', 'desc')
      .limit(limit)
      .execute()

    return await decorate(rows.map(row => ({ id: Number(row.id) })))
  }
  catch (error) {
    console.error('[explore] by topic failed:', error)

    return []
  }
}

/**
 * Public repositories written mostly in a language.
 *
 * Ordered by how much of it they contain rather than by stars, because the
 * question "what Rust is on this instance" is better answered by the Rust
 * repositories than by the popular ones that happen to have a build script in
 * it. The breakdown makes that orderable; a single `language` column would not.
 */
export async function byLanguage(language: string, limit = EXPLORE_LIMIT): Promise<ExploreRepository[]> {
  const wanted = String(language ?? '').trim()

  if (!wanted)
    return []

  try {
    const rows: any[] = await db
      .selectFrom('repository_languages')
      .innerJoin('repositories', 'repositories.id', '=', 'repository_languages.repository_id')
      .select(['repositories.id as id'])
      .where('repository_languages.language', '=', wanted)
      .where('repositories.visibility', '=', 'public')
      .orderBy('repository_languages.percent', 'desc')
      .limit(limit)
      .execute()

    return await decorate(rows.map(row => ({ id: Number(row.id) })))
  }
  catch (error) {
    console.error('[explore] by language failed:', error)

    return []
  }
}

/** Every language present on the instance, most repositories first. */
export async function languageIndex(limit = 30): Promise<{ language: string, repositories: number }[]> {

  try {
    const rows: any[] = await db.unsafe(
      portable(`SELECT "l"."language", COUNT(DISTINCT "l"."repository_id") AS "repositories"
      FROM "repository_languages" "l"
      JOIN "repositories" "r" ON "r"."id" = "l"."repository_id"
      WHERE "r"."visibility" = 'public'
      GROUP BY "l"."language"
      ORDER BY "repositories" DESC, "l"."language" ASC
      LIMIT $1`),
      [limit],
    ).execute()

    return rows.map(row => ({ language: String(row.language), repositories: Number(row.repositories) || 0 }))
  }
  catch (error) {
    console.error('[explore] language index failed:', error)

    return []
  }
}

/**
 * Fill in what a card shows, for a page of ids.
 *
 * One query per table rather than one per row: an explore page is twenty-four
 * repositories, and the version that looks up each owner as it renders is
 * seventy-two queries for a page nobody waits for.
 */
async function decorate(rows: readonly { id: number, gained?: number }[]): Promise<ExploreRepository[]> {
  const ids = rows.map(row => row.id)

  if (ids.length === 0)
    return []

  const repositories: any[] = await db
    .selectFrom('repositories')
    .select(['id', 'name', 'description', 'stars_count', 'owner_type', 'owner_id', 'pushed_at'])
    .where('id', 'in', ids)
    .execute()

  const owners = await ownerHandles(repositories)
  const languages = await primaryLanguages(ids)
  const byId = new Map(repositories.map(row => [Number(row.id), row]))

  // Mapped over the *input* order, because the ordering is the answer: a
  // trending list re-sorted by whatever the database returned is not a trending
  // list.
  return rows.flatMap((row) => {
    const repository = byId.get(row.id)

    if (!repository)
      return []

    return [{
      owner: owners.get(`${repository.owner_type}:${repository.owner_id}`) ?? '',
      name: String(repository.name),
      description: repository.description ? String(repository.description) : null,
      stars: Number(repository.stars_count) || 0,
      language: languages.get(row.id) ?? null,
      pushedAt: repository.pushed_at ? String(repository.pushed_at) : null,
      ...(row.gained === undefined ? {} : { gained: row.gained }),
    }]
  })
}

/** The largest language of each repository, for the card. */
export async function primaryLanguages(ids: readonly number[]): Promise<Map<number, string>> {
  const primary = new Map<number, string>()

  try {
    const rows: any[] = await db
      .selectFrom('repository_languages')
      .select(['repository_id', 'language', 'bytes'])
      .where('repository_id', 'in', ids)
      .orderBy('bytes', 'desc')
      .execute()

    for (const row of rows) {
      const id = Number(row.repository_id)

      // Ordered by bytes descending, so the first seen is the largest.
      if (!primary.has(id))
        primary.set(id, String(row.language))
    }
  }
  catch {
    // No breakdown yet is a card with no language on it, which is honest for a
    // repository nobody has measured.
  }

  return primary
}

/** Handles for a page, in two queries rather than one per row. */
async function ownerHandles(repositories: readonly any[]): Promise<Map<string, string>> {
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
      // A card with no owner is not renderable, and `decorate` drops it rather
      // than showing a repository nobody can navigate to.
    }
  }

  return handles
}
