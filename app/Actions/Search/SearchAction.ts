import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { isSearchableScope, runSearch } from './run'

/**
 * Search, as JSON.
 *
 * The work is `run.ts`, shared with the search page so the two cannot answer
 * the same question differently. This is the HTTP shape around it: who is
 * asking, what they asked, and which status a failure deserves.
 */
export default new Action({
  name: 'Search',
  description: 'Search repositories, issues, pull requests and people',
  method: 'GET',

  // Declared so the document can publish them. Read with `request.get?.()` and
  // a fallback to `request.query`, because this endpoint is reached both from
  // the site's own search box and from a program, and the two arrive
  // differently - which is exactly the kind of thing a caller cannot guess and
  // the document should say.
  validations: {
    q: { rule: schema.string() },
    scope: { rule: schema.enum(['repositories', 'issues', 'pulls', 'users', 'code']) },
    page: { rule: schema.number() },
    per_page: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const viewer = await currentUser(request)
    const scope = String(request.get?.('scope') ?? 'repositories')

    if (!isSearchableScope(scope)) {
      // People are indexed but not wired through yet. An empty list would read
      // as "nothing matched", which is a lie that costs somebody an afternoon.
      return response.json({ error: `The ${scope} scope is not searchable yet` }, 501)
    }

    const outcome = await runSearch({
      query: String(request.get?.('q') ?? request.query?.q ?? ''),
      scope,
      viewerId: viewer?.id ?? null,
      page: Number(request.get?.('page') ?? 1),
      perPage: Number(request.get?.('per_page') ?? 20),
    })

    // A search node that is down is a degraded feature, not a broken page, and
    // it is not a 200 with an empty list either - that reads as "no matches".
    if (outcome.unavailable)
      return response.json({ error: 'Search is unavailable right now', detail: outcome.unavailable }, 503)

    return response.json({
      query: outcome.query,
      scope: outcome.scope,
      page: outcome.page,
      per_page: outcome.perPage,
      total: outcome.total,
      results: outcome.results,
    })
  },
})
