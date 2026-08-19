import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { indexedRepositories } from './build'
import { searchInstance, type Searchable } from './search'

/**
 * Code search across every repository the caller can read.
 *
 * The narrowing is described in `search.ts`; this is the part that decides
 * *which* repositories are in scope, which is a permission question and is
 * answered before anything is searched. A repository somebody cannot read is
 * not searched, so it cannot contribute a match, so its existence cannot be
 * inferred from a result - the same rule the in-repository endpoint follows by
 * answering 404 rather than 403.
 *
 * Ordered by recent activity rather than by name, because this is capped: a
 * truncated search should return the answers from the repositories somebody is
 * most likely to have meant.
 */
export default new Action({
  name: 'SearchCodeInstance',
  description: 'Search code across every repository the caller can read',

  method: 'GET',

  validations: {
    q: { rule: schema.string().required() },
  },

  async handle(request: any) {
    const { response } = await import('@stacksjs/router')
    const pattern = String(request.get('q') ?? '').trim()

    // The same two bounds the per-repository endpoint has, and for the same
    // reasons: one character matches every line in the instance, and a very
    // long pattern is a backtracking engine held open.
    if (pattern.length < 3)
      return response.json({ error: 'Search for at least three characters.' }, 422)

    if (pattern.length > 512)
      return response.json({ error: 'That pattern is too long to search for.' }, 422)

    const viewerId = Number(request.user?.id ?? 0) || null

    /*
     * Only repositories with a shard.
     *
     * Not a permission decision - an unindexed repository is one this cannot
     * search *quickly*, and searching every repository on the instance in full
     * is the thing a trigram index exists to avoid. `buddy search:index` is
     * what brings the rest in, and the response says how many were considered
     * so an operator can tell the difference between "no matches" and "nothing
     * is indexed yet".
     */
    const indexed = await indexedRepositories()

    if (indexed.length === 0) {
      return response.json({
        results: [],
        repositories: 0,
        note: 'No repositories are indexed yet. Run `buddy search:index`.',
      })
    }

    const { readableRepositoryIds } = await import('../Search/visibility')
    const readable = await readableRepositoryIds(indexed, viewerId)

    if (readable.size === 0)
      return response.json({ results: [], repositories: 0 })

    const rows = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id', 'default_branch', 'pushed_at'])
      .where('id', 'in', [...readable])
      .orderBy('pushed_at', 'desc')
      .limit(500)
      .execute()

    const { repositoryPath } = await import('../Git/storage')
    const { ownerHandleFor } = await import('../Repo/owner')

    const searchable: Searchable[] = []

    for (const row of rows) {
      const handle = await ownerHandleFor(row)

      if (!handle)
        continue

      const resolved = repositoryPath(handle, String(row.name))

      if (!resolved.ok)
        continue

      searchable.push({
        id: Number(row.id),
        owner: handle,
        name: String(row.name),
        diskPath: resolved.path!,
        defaultBranch: String(row.default_branch ?? 'main'),
      })
    }

    const outcome = await searchInstance(searchable, {
      pattern,
      regex: String(request.get('regex') ?? '') === 'true',
      caseSensitive: String(request.get('case') ?? '') === 'true',
      language: String(request.get('language') ?? ''),
      limit: Math.min(Math.max(Number(request.get('limit') ?? 100), 1), 200),
    })

    return response.json({
      results: outcome.results.map(one => ({
        repository: `${one.repository.owner}/${one.repository.name}`,
        matches: one.matches,
        // Reported rather than hidden: a repository searched without narrowing
        // is one whose index is missing or stale, and an operator looking at a
        // slow search wants to know which.
        narrowed: !one.unnarrowed,
      })),
      repositories: searchable.length,
      // The number the index earned: repositories it excluded without a single
      // git process starting.
      skipped_by_index: outcome.skippedByIndex,
      searched: outcome.searched,
      truncated: outcome.truncated,
    })
  },
})
