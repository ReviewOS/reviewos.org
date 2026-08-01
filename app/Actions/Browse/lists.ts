/**
 * The rules behind the pull request and issue lists.
 *
 * Pure, so the parts that are easy to get subtly wrong - which filter a query
 * string means, how a page number is bounded, how a count reads in English -
 * are tested rather than trusted.
 */

export type ListFilter = 'open' | 'closed' | 'all'

/**
 * Which set a query string asks for.
 *
 * `open` is the default because it answers the question people arrive with:
 * what needs attention. A repository with two thousand merged pull requests
 * opening on all of them buries the twelve that are live.
 */
export function listFilter(raw: string | null | undefined): ListFilter {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'closed') return 'closed'
  if (value === 'all') return 'all'
  return 'open'
}

/** Which list a filter is being applied to. Issues and pull requests differ. */
export type ListKind = 'issues' | 'pulls'

/**
 * The states a filter covers.
 *
 * For pull requests, `closed` includes merged: a merged pull request is closed,
 * and a reader looking through what is finished expects to find it there.
 * `merged` is not a separate tab, it is how it closed, shown per row.
 *
 * An issue has no merged state, and the kind has to be passed rather than
 * assumed because both columns are native Postgres enums. Asking for a value
 * the enum does not define is not an empty result, it is an error - the query
 * fails outright, and the page renders an empty list that looks like a
 * repository with nothing closed in it.
 */
export function statesFor(filter: ListFilter, kind: ListKind = 'pulls'): string[] | null {
  if (filter === 'open') return ['open']
  if (filter === 'closed') return kind === 'issues' ? ['closed'] : ['closed', 'merged']
  return null
}

export const PAGE_SIZE = 30

/** A page number that cannot be talked out of being a positive integer. */
export function pageNumber(raw: string | null | undefined): number {
  const value = Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.floor(value)
}

export function pageOffset(page: number, size: number = PAGE_SIZE): number {
  return (pageNumber(String(page)) - 1) * size
}

/**
 * The last page that has anything on it.
 *
 * At least one, so an empty list still has a page to be on rather than
 * rendering "page 1 of 0".
 */
export function lastPage(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size))
}

/**
 * How a pull request's state reads.
 *
 * Merged is separated from closed everywhere it is shown, because they are
 * different outcomes: one landed and one was withdrawn, and a list that calls
 * both "closed" hides which.
 */
export function stateLabel(state: string, draft = false): string {
  if (draft && state === 'open') return 'Draft'
  if (state === 'merged') return 'Merged'
  if (state === 'closed') return 'Closed'
  return 'Open'
}

/**
 * The `pill-*` modifier for a state.
 *
 * Names an existing class in the layout rather than returning utility classes,
 * so a state reads the same on the list as it does on the pull request itself.
 * Two places deciding independently what merged looks like is how they drift.
 */
export function statePill(state: string, draft = false): string {
  if (draft && state === 'open') return 'draft'
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'closed'
  return 'open'
}

/**
 * The author to show for a row.
 *
 * A local account when there is one, the upstream login when the row was
 * mirrored, and a plain word when neither exists. Never blank: a row with no
 * author at all reads as a bug in the page rather than a fact about the row.
 */
export function authorLabel(handle: string | null | undefined, externalAuthor: string | null | undefined): string {
  const local = String(handle ?? '').trim()
  if (local) return local

  const external = String(externalAuthor ?? '').trim()
  return external || 'someone'
}

/** Whether an author is only a name, so the interface can avoid linking it. */
export function authorIsLocal(handle: string | null | undefined): boolean {
  return String(handle ?? '').trim().length > 0
}

/**
 * A count with its noun, pluralised.
 *
 * Small, and worth having in one place: "1 pull requests" is the kind of thing
 * that survives review and then reads as carelessness on every page.
 */
export function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}

/**
 * The query string for a filter link, preserving nothing else.
 *
 * Changing the filter resets to the first page on purpose: page 40 of the open
 * list rarely exists in the closed one, and landing on an empty page reads as
 * "there is nothing here".
 */
export function filterHref(base: string, filter: ListFilter): string {
  return filter === 'open' ? base : `${base}?state=${filter}`
}

export function pageHref(base: string, filter: ListFilter, page: number): string {
  const parts: string[] = []
  if (filter !== 'open') parts.push(`state=${filter}`)
  if (page > 1) parts.push(`page=${page}`)
  return parts.length === 0 ? base : `${base}?${parts.join('&')}`
}
