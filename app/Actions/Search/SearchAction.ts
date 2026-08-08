import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { REPOSITORY_INDEX } from './documents'
import { freeText, parseQuery, sortFor, valuesFor } from './query'
import { filterToReadable } from './visibility'

/**
 * Search, across the scopes a forge actually has.
 *
 * Three things compose here and each one already exists: `query.ts` turns what
 * somebody typed into terms and qualifiers, the search engine turns that into
 * candidate documents, and `visibility.ts` decides which of those the reader is
 * allowed to see. This is the wiring, and it deliberately owns none of that
 * logic itself.
 *
 * **Over-fetch, then filter.** The index is asked for more hits than the page
 * needs, because the visibility check removes some of them and a page that
 * returned four results out of twenty because sixteen were private would be a
 * page that leaks the count. Asking for a multiple and trimming after is the
 * cheap way to keep the page full without telling anybody how much they cannot
 * see.
 *
 * **The filter is never skipped, for anybody.** There is no "this user is an
 * admin so return the raw hits" path, because that is the branch that gets
 * copied into the next endpoint by somebody who does not know why it was safe.
 */
export default new Action({
  name: 'Search',
  description: 'Search repositories, issues, pull requests and people',
  method: 'GET',

  async handle(request: any) {
    const viewer = await currentUser(request)
    const viewerId = viewer?.id ?? null

    const raw = String(request.get?.('q') ?? request.query?.q ?? '').trim()
    if (!raw)
      return response.json({ query: '', scope: 'repositories', results: [], total: 0 })

    const scope = String(request.get?.('scope') ?? 'repositories')
    if (scope !== 'repositories') {
      // Issues, pull requests and people are indexed but not yet wired through
      // here. Answering with an empty list would read as "nothing matched",
      // which is a lie that costs somebody an afternoon.
      return response.json({ error: `The ${scope} scope is not searchable yet` }, 501)
    }

    const parsed = parseQuery(raw)
    const perPage = clamp(Number(request.get?.('per_page') ?? 20), 1, 50)
    const page = Math.max(1, Number(request.get?.('page') ?? 1))

    const { useSearchEngine } = await import('@stacksjs/search-engine')
    const engine: any = useSearchEngine()

    let hits: any[] = []
    try {
      const answer = await engine.search(REPOSITORY_INDEX, {
        query: freeText(parsed) || '*',
        queryBy: ['name', 'full_name', 'owner', 'description', 'topics'],
        filter_by: filtersFor(parsed),
        sort: sortClause(parsed),
        // Over-fetched, so the visibility filter has room to remove without
        // leaving the page short. Capped so a query cannot ask the search node
        // for an unbounded result set.
        perPage: Math.min(250, perPage * 5),
        page,
      })

      hits = answer?.hits ?? []
    }
    catch (error) {
      // A search node that is down is a degraded feature, not a broken page.
      // Saying so is better than an empty result set that reads as "no matches".
      return response.json({ error: 'Search is unavailable right now', detail: String((error as Error).message ?? error) }, 503)
    }

    const documents = hits.map((hit: any) => hit?.document ?? hit).filter(Boolean)

    // The only thing standing between this reader and a private repository's
    // name. See `visibility.ts`: the index is a candidate generator and the
    // database is the authority.
    const visible = await filterToReadable(documents, doc => Number(doc.id), viewerId)

    return response.json({
      query: raw,
      scope,
      page,
      per_page: perPage,
      // What the reader may see on this page. Deliberately not the index's
      // `found`, which counts documents they are not entitled to know exist.
      total: visible.length,
      results: visible.slice(0, perPage).map((doc: any) => ({
        id: Number(doc.id),
        name: String(doc.name ?? ''),
        full_name: String(doc.full_name ?? ''),
        owner: String(doc.owner ?? ''),
        description: String(doc.description ?? ''),
        topics: Array.isArray(doc.topics) ? doc.topics : [],
        visibility: String(doc.visibility ?? ''),
        stars_count: Number(doc.stars_count ?? 0),
        pushed_at: Number(doc.pushed_at ?? 0),
      })),
    })
  },
})

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value))
    return low

  return Math.min(high, Math.max(low, Math.floor(value)))
}

/**
 * The qualifiers that map onto index fields, as a Typesense filter.
 *
 * Only the ones that are columns on the document. `author:` and `label:` belong
 * to issues and pull requests and are ignored here rather than silently
 * matching nothing - a qualifier that quietly does nothing is worse than one
 * that is not supported, because the reader believes the results were filtered.
 *
 * Values are escaped: a qualifier value comes from whatever somebody typed, and
 * a backtick in it would otherwise close the filter expression early.
 */
function filtersFor(parsed: ReturnType<typeof parseQuery>): string | undefined {
  const clauses: string[] = []

  const owner = [...valuesFor(parsed, 'org'), ...valuesFor(parsed, 'owner'), ...valuesFor(parsed, 'user')]
  if (owner.length > 0)
    clauses.push(`owner:=[${owner.map(escape).join(',')}]`)

  const topics = valuesFor(parsed, 'topic')
  if (topics.length > 0)
    clauses.push(`topics:=[${topics.map(escape).join(',')}]`)

  // `is:` carries several unrelated meanings; only the two that are fields here
  // are honoured.
  const is = valuesFor(parsed, 'is')
  if (is.includes('fork'))
    clauses.push('is_fork:=true')
  if (is.includes('archived'))
    clauses.push('is_archived:=true')

  const notIs = valuesFor(parsed, 'is', true)
  if (notIs.includes('fork'))
    clauses.push('is_fork:=false')
  if (notIs.includes('archived'))
    clauses.push('is_archived:=false')

  return clauses.length > 0 ? clauses.join(' && ') : undefined
}

function escape(value: string): string {
  return `\`${String(value).replace(/`/g, '')}\``
}

/**
 * How the results are ordered.
 *
 * "Recently active first" is the default a forge wants: a repository pushed to
 * this morning is almost always a better answer than one that matched slightly
 * better and has been still for three years. Relevance still decides ties,
 * because Typesense sorts by text match before anything listed here.
 */
function sortClause(parsed: ReturnType<typeof parseQuery>): string | undefined {
  const { field, direction } = sortFor(parsed)

  switch (field) {
    case 'stars':
      return `stars_count:${direction}`
    case 'newest':
      return 'pushed_at:desc'
    case 'oldest':
      return 'pushed_at:asc'
    case 'updated':
      return `updated_at:${direction}`
    case 'best':
    default:
      // Recent activity as the tiebreaker behind relevance.
      return 'pushed_at:desc'
  }
}
