import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { ISSUE_INDEX, REPOSITORY_INDEX } from './documents'
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
    if (scope !== 'repositories' && scope !== 'issues' && scope !== 'pulls') {
      // People are indexed but not wired through here yet. Answering with an
      // empty list would read as "nothing matched", which is a lie that costs
      // somebody an afternoon.
      return response.json({ error: `The ${scope} scope is not searchable yet` }, 501)
    }

    const parsed = parseQuery(raw)
    const perPage = clamp(Number(request.get?.('per_page') ?? 20), 1, 50)
    const page = Math.max(1, Number(request.get?.('page') ?? 1))

    const { useSearchEngine } = await import('@stacksjs/search-engine')
    const engine: any = useSearchEngine()

    // Issues and pull requests are the same corpus - a pull request *is* an
    // issue row with `is_pull_request` set - so they share an index and differ
    // by one filter. Two indexes for one table would mean two projections and
    // two chances for them to disagree.
    const onIssues = scope === 'issues' || scope === 'pulls'
    const index = onIssues ? ISSUE_INDEX : REPOSITORY_INDEX

    let hits: any[] = []
    try {
      const answer = await engine.search(index, {
        query: freeText(parsed) || '*',
        queryBy: onIssues
          ? ['title', 'body', 'labels', 'author', 'repository']
          : ['name', 'full_name', 'owner', 'description', 'topics'],
        filter_by: onIssues ? issueFilters(parsed, scope) : filtersFor(parsed),
        sort: onIssues ? issueSort(parsed) : sortClause(parsed),
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
    // Repositories are filtered on their own id; issues on the repository they
    // live in, because an issue is readable exactly when its repository is.
    const visible = await filterToReadable(
      documents,
      doc => Number(onIssues ? doc.repository_id : doc.id),
      viewerId,
    )

    return response.json({
      query: raw,
      scope,
      page,
      per_page: perPage,
      // What the reader may see on this page. Deliberately not the index's
      // `found`, which counts documents they are not entitled to know exist.
      total: visible.length,
      results: visible.slice(0, perPage).map((doc: any) => onIssues
        ? {
            id: Number(doc.id),
            repository: String(doc.repository ?? ''),
            number: Number(doc.number ?? 0),
            title: String(doc.title ?? ''),
            author: String(doc.author ?? ''),
            labels: Array.isArray(doc.labels) ? doc.labels : [],
            state: String(doc.state ?? ''),
            is_pull_request: Boolean(doc.is_pull_request),
            comments_count: Number(doc.comments_count ?? 0),
            updated_at: Number(doc.updated_at ?? 0),
          }
        : {
            id: Number(doc.id),
            name: String(doc.name ?? ''),
            full_name: String(doc.full_name ?? ''),
            owner: String(doc.owner ?? ''),
            description: String(doc.description ?? ''),
            topics: Array.isArray(doc.topics) ? doc.topics : [],
            visibility: String(doc.visibility ?? ''),
            stars_count: Number(doc.stars_count ?? 0),
            pushed_at: Number(doc.pushed_at ?? 0),
          }),
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

/**
 * The qualifiers people already know, for issues and pull requests.
 *
 * `is:open`, `is:closed`, `author:`, `label:` - the ones every forge uses, and
 * the reason the document denormalizes author and labels rather than storing
 * ids. Resolving a handle to an id at query time would be one query; doing it
 * for every hit afterwards would be one per result.
 *
 * The scope itself is a filter: `pulls` and `issues` are the same rows, split
 * by `is_pull_request`. That is what the tabs mean.
 */
function issueFilters(parsed: ReturnType<typeof parseQuery>, scope: string): string | undefined {
  const clauses: string[] = [scope === 'pulls' ? 'is_pull_request:=true' : 'is_pull_request:=false']

  const is = valuesFor(parsed, 'is')
  const state = valuesFor(parsed, 'state')
  const wanted = [...is, ...state].filter(value => value === 'open' || value === 'closed' || value === 'merged')

  // `is:merged` is a pull request that closed as merged; the row records it as
  // a state, so it needs no special case beyond being allowed through.
  if (wanted.length > 0)
    clauses.push(`state:=[${wanted.map(escape).join(',')}]`)

  const authors = valuesFor(parsed, 'author')
  if (authors.length > 0)
    clauses.push(`author:=[${authors.map(escape).join(',')}]`)

  const labels = valuesFor(parsed, 'label')
  if (labels.length > 0)
    clauses.push(`labels:=[${labels.map(escape).join(',')}]`)

  const notLabels = valuesFor(parsed, 'label', true)
  if (notLabels.length > 0)
    clauses.push(`labels:!=[${notLabels.map(escape).join(',')}]`)

  return clauses.join(' && ')
}

/** Most recently updated first, which is what an issue list means by "active". */
function issueSort(parsed: ReturnType<typeof parseQuery>): string | undefined {
  const { field, direction } = sortFor(parsed)

  switch (field) {
    case 'newest':
      return 'created_at:desc'
    case 'oldest':
      return 'created_at:asc'
    case 'comments':
      return `comments_count:${direction}`
    case 'updated':
    case 'best':
    default:
      return 'updated_at:desc'
  }
}
