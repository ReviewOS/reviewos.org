import type { Entry, InboxFilter } from './inbox'
import { collapse, filterInbox, parseEntry, repositoriesIn, unreadCount } from './inbox'

/**
 * Load somebody's inbox.
 *
 * Shared by the page and the API endpoint rather than written twice, so the two
 * cannot disagree about what the unread count is. That number appears in a
 * badge next to a link people trust, and a badge that says 3 next to a page
 * showing 0 is worse than no badge.
 *
 * Filtering happens in the application rather than in SQL because the reason
 * and the repository live inside a JSON column. Matching on a substring of that
 * blob would count a repository named in a pull request *title* as a repository
 * filter, which is the kind of wrong that only shows up once somebody has a
 * repository called `main` or `test`.
 */

/** How far back the inbox reads. Nobody scrolls past this; they filter. */
const CEILING = 500

export interface Inbox {
  /** After filtering and collapsing, newest first. */
  entries: ReturnType<typeof collapse>
  /** Across everything unread, not only what the filter left. */
  unread: number
  /** Repositories represented, for the filter strip. */
  repositories: { repository: string, unread: number, total: number }[]
  /** Whether the ceiling was hit, so the page can say so rather than imply completeness. */
  truncated: boolean
}

export async function loadInbox(userId: number, filter: InboxFilter = {}): Promise<Inbox> {
  const rows: any[] = await db
    .selectFrom('notifications')
    .select(['id', 'type', 'data', 'read_at', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(CEILING + 1)
    .execute()

  const truncated = rows.length > CEILING
  const all: Entry[] = rows.slice(0, CEILING).map(parseEntry)

  return {
    entries: collapse(filterInbox(all, filter)),
    // Counted over everything rather than over the filtered view. A badge that
    // drops when somebody applies a filter is telling them their unread went
    // away, and it did not.
    unread: unreadCount(all),
    repositories: repositoriesIn(all),
    truncated,
  }
}

/**
 * The unread count alone, for a header badge.
 *
 * A separate query rather than `loadInbox().unread`, because the badge renders
 * on every page and reading five hundred rows to display one integer is the
 * kind of cost that only becomes visible once the product is worth using.
 */
export async function unreadFor(userId: number): Promise<number> {
  const row: any = await db
    .selectFrom('notifications')
    .select(db.fn.count('id').as('unread'))
    .where('user_id', '=', userId)
    .whereNull('read_at')
    .executeTakeFirst()

  return Number(row?.unread ?? 0)
}
