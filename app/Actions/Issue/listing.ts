/**
 * What an issue list query means.
 *
 * Pure: parsing a query string, deciding a sort, and encoding the cursor that
 * gets somebody to the next page. The database work is the action's; the rules
 * are here so they can be tested against the ways a query string lies.
 *
 * **Keyset, not offset.** An offset page is wrong exactly when it matters: a
 * repository where issues are being opened while somebody pages through them
 * shifts every row down, so page two repeats what page one showed and an issue
 * is never seen. It also gets slower the deeper you go, because the database
 * counts and discards every row it skips. A cursor names the last row of the
 * page instead, and the next query starts after it - stable under inserts, and
 * the same cost on page one hundred as on page one.
 */

export const ISSUE_SORTS = ['created', 'updated', 'comments'] as const
export type IssueSort = typeof ISSUE_SORTS[number]

/**
 * Whether a sort can be paged through.
 *
 * A cursor has to name a row uniquely, or the page boundary lands in the middle
 * of a tie and one of the tied rows is never returned. `created` can: issue ids
 * are assigned in creation order, so the id *is* the creation order and is
 * unique by construction.
 *
 * `updated` and `comments` cannot. Two issues touched in the same second, or
 * with the same comment count, need the pair `(value, id)` compared as a tuple,
 * which is an `OR` - and the query builder in use here ignores its
 * expression-callback form outright and drops the bound values from a raw
 * fragment on Postgres. Rather than emit a pager that quietly repeats rows,
 * those sorts answer one page and say so by returning no cursor. See the note
 * in the phase 3 roadmap.
 */
export function isPageable(sort: IssueSort): boolean {
  return sort === 'created'
}

export const ISSUE_STATES = ['open', 'closed', 'all'] as const
export type IssueStateFilter = typeof ISSUE_STATES[number]

/** The column each sort orders by. */
export const SORT_COLUMNS: Record<IssueSort, string> = {
  created: 'created_at',
  updated: 'updated_at',
  comments: 'comments_count',
}

export interface IssueQuery {
  state: IssueStateFilter
  sort: IssueSort
  /** Newest or highest first. The default, and what people expect from a list. */
  descending: boolean
  /** Label names, all of which must be present. */
  labels: string[]
  /** Handle, or `none` for unassigned. Null means no filter. */
  assignee: string | null
  author: string | null
  /** Milestone title, or `none` for issues in no milestone. Null means no filter. */
  milestone: string | null
  /** Free text matched against title and body. */
  search: string | null
  limit: number
  cursor: IssueCursor | null
}

/**
 * Where the previous page stopped.
 *
 * Just the id. It is unique, and for the one sort that pages (`created`) it is
 * also the sort order, so no tiebreak is needed and no value has to travel.
 */
export interface IssueCursor {
  id: number
}

export const DEFAULT_LIMIT = 30
export const MAX_LIMIT = 100

/**
 * How many matches a filter resolved as ids will collect.
 *
 * Relation and text filters are answered by looking up the matching issue ids
 * and passing them back as an `IN`, so the list has to stop somewhere. Beyond
 * this the filter is not narrowing anything a person is reading anyway, and
 * phase 6's search index is the right answer for that shape of query.
 */
export const MATCH_LIMIT = 5000

/** A sentinel that means "has none of these", for assignee and milestone. */
export const NONE = 'none'

function one(raw: unknown): string | null {
  if (raw === undefined || raw === null)
    return null

  const value = String(Array.isArray(raw) ? raw[0] ?? '' : raw).trim()

  return value.length > 0 ? value : null
}

/**
 * The cursor as it travels in a URL.
 *
 * Base64 of `i<id>`, opaque enough that nobody builds one by hand and expects
 * it to keep working, and simple enough to read in a log when a page comes back
 * wrong. It carries no privileged information: the id is already on the last
 * row the caller saw.
 */
export function encodeCursor(cursor: IssueCursor): string {
  return Buffer.from(`i${cursor.id}`, 'utf8').toString('base64url')
}

/** A cursor, or null when it is absent or does not decode. */
export function decodeCursor(raw: unknown): IssueCursor | null {
  const encoded = one(raw)
  if (!encoded)
    return null

  let decoded: string
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8')
  }
  catch {
    return null
  }

  if (!decoded.startsWith('i'))
    return null

  const id = Number(decoded.slice(1))
  if (!Number.isInteger(id) || id <= 0)
    return null

  return { id }
}

/**
 * Read a query string into a query.
 *
 * Every unrecognised value falls back to the default rather than being an
 * error. A list is a place people arrive at from a stale link or a hand-edited
 * URL, and answering "open issues, newest first" is more useful than a 422.
 */
export function parseIssueQuery(params: Record<string, unknown>): IssueQuery {
  const rawState = (one(params.state) ?? '').toLowerCase()
  const state = (ISSUE_STATES as readonly string[]).includes(rawState)
    ? rawState as IssueStateFilter
    : 'open'

  const rawSort = (one(params.sort) ?? '').toLowerCase()
  const sort = (ISSUE_SORTS as readonly string[]).includes(rawSort)
    ? rawSort as IssueSort
    : 'created'

  const direction = (one(params.direction) ?? '').toLowerCase()

  const rawLabels = params.labels ?? params.label
  const labels = Array.isArray(rawLabels)
    ? [...new Set(rawLabels.map(label => String(label).trim()).filter(Boolean))]
    : (one(rawLabels) ?? '').split(',').map(label => label.trim()).filter(Boolean)

  const rawLimit = Number(one(params.limit) ?? Number.NaN)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT

  return {
    state,
    sort,
    descending: direction !== 'asc',
    labels: [...new Set(labels)],
    assignee: one(params.assignee)?.toLowerCase() ?? null,
    author: one(params.author)?.toLowerCase() ?? null,
    milestone: one(params.milestone),
    search: one(params.q) ?? one(params.search),
    limit,
    cursor: decodeCursor(params.cursor),
  }
}

/** The states a filter admits, or null for every state. */
export function statesFor(state: IssueStateFilter): string[] | null {
  return state === 'all' ? null : [state]
}

/**
 * The cursor for the page that follows these rows, or null at the end.
 *
 * Null when the page came back short, because a page smaller than the limit is
 * the last one and a cursor to an empty page makes a client ask for it. Null
 * too for a sort that cannot be paged, so a caller is never handed a cursor
 * that would return rows it has already seen.
 */
export function nextCursor(
  rows: ReadonlyArray<Record<string, unknown>>,
  query: IssueQuery,
): IssueCursor | null {
  if (!isPageable(query.sort) || rows.length < query.limit)
    return null

  const last = rows[rows.length - 1]

  return last ? { id: Number(last.id) } : null
}
