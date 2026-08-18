import { describeEntry } from '../../Activity/verbs'

/**
 * Reading a feed.
 *
 * Three of them, and they are different questions. A **profile** feed is "what
 * has this person done", ordered by their own activity. A **dashboard** feed is
 * "what happened in the repositories I watch". A **discover** feed is "what is
 * happening in public repositories on this instance", for finding work outside
 * the reader's existing watch list.
 *
 * Both are keyset paginated rather than offset paginated, and that is not
 * premature. `OFFSET 2000` makes Postgres read and discard two thousand rows to
 * return twenty, so the tenth page of a busy feed costs ten times the first -
 * and a feed is the one page people page through. Keying on the id means every
 * page costs the same.
 *
 * **Visibility is a stored column, not a join.** `is_public` was decided when
 * the row was written; adding a join to `repositories` here would both cost the
 * index and reintroduce the retroactive-disclosure problem the column exists to
 * avoid.
 */

/** One page. */
export interface FeedPage {
  entries: FeedRow[]
  /** Pass back as `before` for the next page. Null when there is no more. */
  cursor: number | null
}

export interface FeedRow {
  id: number
  actorId: number
  actorHandle: string
  verb: string
  phrase: string
  target: string
  title: string
  url: string
  at: number
}

/** How many a page holds. Enough to fill a screen, few enough to stay cheap. */
export const PAGE_SIZE = 20

/**
 * Turn stored rows into sentences, dropping any that cannot be rendered.
 *
 * A row naming a verb this version does not know renders as nothing rather
 * than as a gap or an error. A feed that refused to load because one row named
 * a verb a later deploy removed is a feed a single revert can take down.
 */
export function toRows(rows: readonly any[], handles: Map<number, string>): FeedRow[] {
  const out: FeedRow[] = []

  for (const row of rows) {
    let detail: any = {}

    try {
      detail = row.detail ? JSON.parse(String(row.detail)) : {}
    }
    catch {
      detail = {}
    }

    const entry = describeEntry({
      verb: String(row.verb ?? ''),
      repository: String(detail.repository ?? ''),
      number: detail.number == null ? null : Number(detail.number),
      detail: String(detail.tag ?? ''),
      subjectType: String(row.subject_type ?? ''),
    })

    if (!entry)
      continue

    out.push({
      id: Number(row.id),
      actorId: Number(row.actor_id),
      actorHandle: handles.get(Number(row.actor_id)) ?? '',
      verb: String(row.verb),
      phrase: entry.phrase,
      target: entry.target,
      title: String(detail.title ?? ''),
      url: entry.url,
      at: toEpoch(row.created_at),
    })
  }

  return out
}

function toEpoch(value: unknown): number {
  if (value instanceof Date)
    return value.getTime()

  const parsed = Date.parse(String(value ?? ''))

  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * What one person has done, as anybody may see it.
 *
 * `viewerId` decides how much. Looking at your own profile shows private
 * activity too, because it is yours; looking at somebody else's shows only what
 * was public when it happened. There is deliberately no middle case where a
 * collaborator sees a colleague's private activity: that would make a profile
 * page's contents depend on a permission graph, and the first bug in it is a
 * disclosure rather than a missing row.
 */
export async function profileFeed(options: {
  actorId: number
  viewerId: number | null
  before?: number | null
  limit?: number
}): Promise<FeedPage> {
  const limit = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), 100)
  const own = options.viewerId !== null && options.viewerId === options.actorId

  let query = db
    .selectFrom('activity_events')
    .select(['id', 'actor_id', 'verb', 'subject_type', 'detail', 'created_at'])
    .where('actor_id', '=', options.actorId)

  if (!own)
    query = query.where('is_public', '=', true)

  if (options.before)
    query = query.where('id', '<', Number(options.before))

  // Ordered by id rather than by `created_at`, deliberately. Two events written
  // in the same millisecond have no stable order by time, so a cursor on time
  // can skip one or repeat one at a page boundary - and the id is monotonic,
  // matches the index's second column in practice, and is what the cursor is.
  const rows: any[] = await query
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute()

  return page(rows, limit)
}

/**
 * What happened where the reader is looking.
 *
 * The repositories they watch, plus their own activity so a new account's
 * dashboard is not empty. Deliberately not "everybody I follow": following
 * people is not a thing this product has, and a feed built on a relationship
 * that does not exist is a feed that is always empty.
 */
export async function dashboardFeed(options: {
  viewerId: number
  before?: number | null
  limit?: number
}): Promise<FeedPage> {
  const limit = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), 100)

  /*
   * `all`, not every row in `watches`.
   *
   * The three subscriptions mean different things and only one of them is a
   * request for a feed. `participating` means "tell me about the threads I am
   * in", which the inbox already does; `ignore` is an explicit no. Treating
   * either as "watching" would fill somebody's dashboard with the repositories
   * they deliberately turned down, which is how a feed becomes a page people
   * stop opening.
   */
  const watched = await db
    .selectFrom('watches')
    .select(['repository_id'])
    .where('user_id', '=', options.viewerId)
    .where('subscription', '=', 'all')
    .execute()

  const repositoryIds = await stillReadable(
    watched.map(row => Number(row.repository_id)).filter(Boolean),
    options.viewerId,
  )

  // Nothing watched: their own activity, which is what a new account has. An
  // empty dashboard reads as a broken page, and "here is what you did" is both
  // true and a prompt to go and watch something.
  if (repositoryIds.length === 0) {
    return profileFeed({ actorId: options.viewerId, viewerId: options.viewerId, before: options.before, limit })
  }

  let query = db
    .selectFrom('activity_events')
    .select(['id', 'actor_id', 'verb', 'subject_type', 'detail', 'created_at'])
    .where('repository_id', 'in', repositoryIds)

  if (options.before)
    query = query.where('id', '<', Number(options.before))

  const rows: any[] = await query
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute()

  return page(rows, limit)
}

/**
 * Public work happening across the instance.
 *
 * This checks both the event's recorded visibility and the repository's current
 * visibility. `is_public` prevents a repository made public today from exposing
 * events written while it was private. The join prevents a repository made
 * private today from remaining advertised on a discovery page that links to a
 * place the reader can no longer open.
 */
export async function discoverFeed(options: {
  before?: number | null
  limit?: number
} = {}): Promise<FeedPage> {
  const limit = Math.min(Math.max(1, options.limit ?? PAGE_SIZE), 100)

  let query = db
    .selectFrom('activity_events')
    .innerJoin('repositories', 'repositories.id', '=', 'activity_events.repository_id')
    .select([
      'activity_events.id as id',
      'activity_events.actor_id as actor_id',
      'activity_events.verb as verb',
      'activity_events.subject_type as subject_type',
      'activity_events.detail as detail',
      'activity_events.created_at as created_at',
    ])
    .where('activity_events.is_public', '=', true)
    .where('repositories.visibility', '=', 'public')

  if (options.before)
    query = query.where('activity_events.id', '<', Number(options.before))

  const rows: any[] = await query
    .orderBy('activity_events.id', 'desc')
    .limit(limit + 1)
    .execute()

  return page(rows, limit)
}

/**
 * Of these repositories, the ones this reader may still see.
 *
 * **A watch row outlives access.** Somebody watches a private repository as a
 * collaborator, is later removed from it, and the row stays - nothing deletes
 * it, and nothing should, because access is often restored. Without this the
 * dashboard would keep reporting that repository's activity to somebody who can
 * no longer open any of it.
 *
 * Two queries over a handful of ids rather than a join on the feed, so the
 * expensive query keeps its index and the cheap one carries the rule. This is
 * the one place a permission check belongs: it filters *which repositories*,
 * once, rather than which events, per row.
 */
async function stillReadable(ids: readonly number[], viewerId: number): Promise<number[]> {
  if (ids.length === 0)
    return []

  const repositories = await db
    .selectFrom('repositories')
    .selectAll()
    .where('id', 'in', [...ids])
    .execute()

  // A public repository needs no lookup at all, and most watched repositories
  // are public - so the expensive path runs for the few that are not.
  const open = repositories.filter(row => String(row.visibility) === 'public')
  const closed = repositories.filter(row => String(row.visibility) !== 'public')

  const { permissionOn } = await import('../Git/access')
  const { canOnRepository } = await import('../../Permissions')

  const allowed: number[] = open.map(row => Number(row.id))

  for (const repository of closed) {
    // Through the same resolver the git wire and every action use. A second
    // implementation of "may this person read this" is how the feed ends up
    // more generous than the repository page, and the direction it is wrong in
    // is the one nobody reports.
    const grants = await permissionOn(repository as any, viewerId)

    if (canOnRepository({
      ...grants,
      userId: viewerId,
      visibility: String(repository.visibility) as any,
      ownerUserId: String(repository.owner_type) === 'user' ? Number(repository.owner_id) : null,
    }, 'repository:read'))
      allowed.push(Number(repository.id))
  }

  return allowed
}

/**
 * Take one more row than asked for, and use its presence as "there is more".
 *
 * A separate `COUNT(*)` would be a second full scan of the same index to learn
 * one boolean, and on the page where it matters - a long feed - it is the
 * expensive half of the request.
 */
function page(rows: readonly any[], limit: number): FeedPage {
  const shown = rows.slice(0, limit)

  return {
    entries: toRows(shown, new Map()),
    cursor: rows.length > limit && shown.length > 0 ? Number(shown[shown.length - 1].id) : null,
  }
}

/**
 * Fill in the handles for a page of rows.
 *
 * One query for the page rather than one per row. Twenty events by three people
 * is three handles, and the join-per-row version is the shape that looks fine
 * on a test fixture and is twenty queries in production.
 */
export async function withHandles(pageOfRows: FeedPage): Promise<FeedPage> {
  const ids = [...new Set(pageOfRows.entries.map(entry => entry.actorId))].filter(Boolean)

  if (ids.length === 0)
    return pageOfRows

  const users = await db
    .selectFrom('users')
    .select(['id', 'handle'])
    .where('id', 'in', ids)
    .execute()

  const handles = new Map(users.map(row => [Number(row.id), String(row.handle)]))

  return {
    ...pageOfRows,
    entries: pageOfRows.entries.map(entry => ({ ...entry, actorHandle: handles.get(entry.actorId) ?? '' })),
  }
}
