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
 * Whether a sort can be paged through. All of them can now.
 *
 * A cursor has to name a row uniquely, or the page boundary lands in the middle
 * of a tie and one of the tied rows is never returned. `created` gets that for
 * free: ids are handed out as issues are opened, so the id *is* the creation
 * order and is unique by construction.
 *
 * `updated` and `comments` tie constantly - a thousand issues with no comments
 * all sort equal - so their boundary is the pair `(value, id)`. The usual way to
 * write that is `col < v OR (col = v AND id < i)`, and this project's query
 * builder cannot express it: the expression-callback form of `where` is
 * rejected, and its raw-fragment form renders the fragment to text and drops the
 * bound values, which is worse than not having it.
 *
 * So the `OR` is not written. `keysetPlan` below decomposes the same boundary
 * into an ordered list of segments, each of which is an `AND` of single-column
 * predicates, and the caller runs them in order until it has a page. It is the
 * same shape the relation filters already use here - resolve it in another
 * query rather than reach for SQL the builder will quietly mangle - and it
 * produces exactly the rows the `OR` would, in exactly the same order.
 */
export function isPageable(_sort: IssueSort): boolean {
  return true
}

export const ISSUE_STATES = ['open', 'closed', 'all'] as const
export type IssueStateFilter = typeof ISSUE_STATES[number]

/** The column each sort orders by. */
export const SORT_COLUMNS: Record<IssueSort, string> = {
  created: 'created_at',
  updated: 'updated_at',
  comments: 'comments_count',
}

/**
 * What kind of value that column holds.
 *
 * The cursor travels as text, and a text value bound against an integer column
 * is a type error on Postgres rather than a comparison. So the type has to be
 * declared somewhere, and it may as well be next to the column name.
 */
export const SORT_VALUE_TYPES: Record<IssueSort, 'number' | 'timestamp'> = {
  created: 'timestamp',
  updated: 'timestamp',
  comments: 'number',
}

/**
 * Whether the sort column can be null, which decides where the nulls sort.
 *
 * `updated_at` is the only one: an issue nobody has touched since it was opened
 * has never had it set. Postgres sorts nulls first on `DESC` and last on `ASC`,
 * and a pager that did not know that would walk straight past them.
 */
export function sortColumnIsNullable(sort: IssueSort): boolean {
  return sort === 'updated'
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
 * The id is always there and is what breaks a tie. `value` is the sort column
 * on that row, and is absent for `created`, where the id already *is* the sort
 * order and a second copy of it would be one more thing to keep consistent.
 * `null` is a value: it means the last row had no `updated_at`, which is a
 * position in the order rather than the absence of one.
 */
export interface IssueCursor {
  id: number
  value?: string | null
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
 * Base64 of one of three forms, opaque enough that nobody builds one by hand
 * and expects it to keep working, and simple enough to read in a log when a
 * page comes back wrong:
 *
 *     i42        the id alone, for `created`
 *     t42|n      id 42, whose sort value was null
 *     t42|v...   id 42, and the sort value after the `v`
 *
 * The value goes last and unescaped on purpose: a timestamp contains no
 * newline, and splitting on the *first* separator means it can contain
 * anything else, `|` included. Nothing privileged travels here - the id and the
 * timestamp are both already on the last row the caller was shown.
 */
export function encodeCursor(cursor: IssueCursor): string {
  if (cursor.value === undefined)
    return Buffer.from(`i${cursor.id}`, 'utf8').toString('base64url')

  const value = cursor.value === null ? 'n' : `v${cursor.value}`

  return Buffer.from(`t${cursor.id}|${value}`, 'utf8').toString('base64url')
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

  const form = decoded[0]
  if (form !== 'i' && form !== 't')
    return null

  const separator = decoded.indexOf('|')
  const idText = form === 'i' ? decoded.slice(1) : decoded.slice(1, separator < 0 ? undefined : separator)

  const id = Number(idText)
  if (!Number.isInteger(id) || id <= 0)
    return null

  if (form === 'i')
    return { id }

  if (separator < 0)
    return null

  const value = decoded.slice(separator + 1)
  if (value === 'n')
    return { id, value: null }

  if (value[0] !== 'v')
    return null

  return { id, value: value.slice(1) }
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
 * One piece of a page, as predicates the query builder can actually express.
 *
 * Each segment is an `AND` of single-column comparisons, which is the whole
 * point: the boundary a keyset page needs is `col < v OR (col = v AND id < i)`,
 * and the `OR` is what this builder cannot write. Split along the `OR` and each
 * half is ordinary.
 *
 * `tie` is the rest of the group the cursor row was sitting in, ordered by id.
 * `beyond` is everything past that group. `nulls` and `nonNulls` are the two
 * blocks Postgres puts at one end or the other, depending on direction.
 */
export type KeysetSegment =
  | { kind: 'all' }
  | { kind: 'afterId', afterId: number }
  | { kind: 'tie', value: string | null, afterId: number }
  | { kind: 'beyond', value: string }
  | { kind: 'nulls' }
  | { kind: 'nonNulls' }

/**
 * How to walk from a cursor to the next page, as segments to run in order.
 *
 * The caller runs them until it has `limit` rows, so a page that falls entirely
 * inside one segment costs one query and a page that straddles a boundary costs
 * two. Ordering *between* segments is this function's job; ordering *within* one
 * is the `orderBy` the caller already writes.
 *
 * Null handling is why this is not two lines. Postgres sorts nulls first on
 * `DESC` and last on `ASC`, and `updated_at` is null on every issue nobody has
 * touched since opening it - which in a young repository is most of them. A
 * pager that assumed non-null would skip that block or return it twice.
 */
export function keysetPlan(query: IssueQuery): KeysetSegment[] {
  const cursor = query.cursor
  if (!cursor)
    return [{ kind: 'all' }]

  // `created` pages on the id alone: ids are handed out in creation order, so
  // the id is the sort key, ties are impossible, and one comparison is the
  // whole answer.
  if (cursor.value === undefined)
    return [{ kind: 'afterId', afterId: cursor.id }]

  const nullable = sortColumnIsNullable(query.sort)

  if (cursor.value === null) {
    // Inside the null block. Descending, that block leads and the non-null rows
    // follow it; ascending, it trails and there is nothing after it.
    const tie: KeysetSegment = { kind: 'tie', value: null, afterId: cursor.id }

    return query.descending ? [tie, { kind: 'nonNulls' }] : [tie]
  }

  const segments: KeysetSegment[] = [
    { kind: 'tie', value: cursor.value, afterId: cursor.id },
    { kind: 'beyond', value: cursor.value },
  ]

  // Ascending, the nulls are at the very end, so they are what follows the last
  // non-null row. Descending, they came first and are already behind us.
  if (nullable && !query.descending)
    segments.push({ kind: 'nulls' })

  return segments
}

/**
 * The value a row contributes to a cursor.
 *
 * Timestamps come back from the driver as `Date` more often than not, and
 * `String(date)` is a human-readable form Postgres will not take back. ISO is
 * the one spelling that survives the round trip.
 */
export function cursorValueOf(row: Record<string, unknown>, sort: IssueSort): string | null {
  const raw = row[SORT_COLUMNS[sort]]

  if (raw === null || raw === undefined)
    return null

  if (raw instanceof Date)
    return raw.toISOString()

  return String(raw)
}

/**
 * The cursor for the page that follows these rows, or null at the end.
 *
 * Null when the page came back short, because a page smaller than the limit is
 * the last one and a cursor to an empty page makes a client ask for it.
 */
export function nextCursor(
  rows: ReadonlyArray<Record<string, unknown>>,
  query: IssueQuery,
): IssueCursor | null {
  if (rows.length < query.limit)
    return null

  const last = rows[rows.length - 1]
  if (!last)
    return null

  // `created` keeps the id-only form, so a cursor already out in the world
  // still means what it meant.
  if (query.sort === 'created')
    return { id: Number(last.id) }

  return { id: Number(last.id), value: cursorValueOf(last, query.sort) }
}
