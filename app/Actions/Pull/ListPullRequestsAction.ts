import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { decodeCursor, isAfter, pageSize, toPage } from '../../Api/cursor'
import { apiError } from '../../Api/errors'
import { conditional, etagFrom } from '../../Api/etag'
import { pick, readFields, withRequired } from '../../Api/fields'
import { authorizeRepository } from '../Repo/authorize'

/**
 * The pull requests in a repository.
 *
 * Written because the CLI needed it and it did not exist, which is the rule
 * this phase set for itself: an endpoint the client needs gets built rather
 * than worked around, and that is what keeps parity honest instead of
 * aspirational. Listing was reachable only by rendering a page.
 *
 * Uses the phase's own primitives rather than reinventing three of them:
 * `cursor` for paging, `etag` for a cheap repeat, `fields` for a caller that
 * only wants numbers and titles.
 */
export default new Action({
  name: 'ListPullRequests',
  description: 'List the pull requests in a repository',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    state: { rule: schema.enum(['open', 'closed', 'merged', 'all']) },
    author: { rule: schema.string() },
    base: { rule: schema.string() },
    per_page: { rule: schema.number() },
    cursor: { rule: schema.string() },
    fields: { rule: schema.string() },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const state = String(request.get('state') ?? 'open')
    if (!['open', 'closed', 'merged', 'all'].includes(state)) {
      return apiError('invalid_field', 'Unknown state', {
        field: 'state',
        fix: 'Use open, closed, merged, or all.',
      })
    }

    const size = pageSize(request.get('per_page'))
    const after = decodeCursor(request.get('cursor'))

    if (request.get('cursor') && !after) {
      return apiError('invalid_field', 'That cursor is not one of ours', {
        field: 'cursor',
        fix: 'Pass the `next` value from a previous page, or omit it to start at the beginning.',
      })
    }

    /*
     * The tag is computed from the newest row and the count, both cheap.
     *
     * Not from the rendered body: hashing the response saves the transfer and
     * none of the work, and building this page means a second query for the
     * authors. The pair moves whenever anything in the list changes - a new
     * pull request bumps the count, an edit bumps the newest `updated_at` -
     * which is exactly the property a tag needs.
     */
    const summary: any = await db
      .selectFrom('pull_requests')
      .select([
        db.fn.count('id').as('count'),
        db.fn.max('updated_at').as('newest'),
      ])
      .where('repository_id', '=', repository.id)
      .executeTakeFirst()

    const tag = etagFrom([
      'pulls',
      repository.id,
      state,
      String(request.get('author') ?? ''),
      String(request.get('base') ?? ''),
      String(request.get('cursor') ?? ''),
      size,
      summary?.count ?? 0,
      summary?.newest ?? '',
    ])

    return await conditional(request, tag, async () => {
      let query = db
        .selectFrom('pull_requests')
        .selectAll()
        .where('repository_id', '=', repository.id)

      if (state !== 'all')
        query = query.where('state', '=', state)

      const base = String(request.get('base') ?? '').trim()
      if (base)
        query = query.where('base_branch', '=', base)

      const author = String(request.get('author') ?? '').trim().toLowerCase()
      if (author) {
        const found: any = await db
          .selectFrom('users')
          .select(['id'])
          .where('handle', '=', author)
          .executeTakeFirst()

        // An unknown handle is an empty list, not an error. A caller filtering
        // by somebody who left should get "none" rather than a 422 it has to
        // special-case.
        query = query.where('author_id', '=', Number(found?.id ?? 0))
      }

      /*
       * Newest first, then by id, and the second half is not decoration.
       * `created_at` alone is not a total ordering: two pull requests opened in
       * the same millisecond straddle a page boundary and one is never
       * returned, which is the exact failure offset paging has and the reason
       * this uses a cursor at all.
       */
      const rows: any[] = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute()

      /*
       * Filtered with the shared comparison rather than a second one written
       * here. Two definitions of "after" is how a cursor comes to skip a row
       * in one endpoint and repeat it in another, and the bug looks like a
       * database problem rather than a disagreement between two functions.
       */
      const ordered = rows.filter(row =>
        isAfter({ value: String(row.created_at ?? ''), id: Number(row.id) }, after, 'desc'),
      )

      const page = toPage(ordered, size, row => ({
        value: String(row.created_at ?? ''),
        id: Number(row.id),
      }))

      const authors = await authorsFor(page.items.map(row => Number(row.author_id)))
      const fields = withRequired(readFields(request.get('fields')), ['number'])

      return response.json({
        pull_requests: page.items.map(row => pick(shape(row, authors), fields)),
        // Null on the last page rather than a cursor that returns nothing: a
        // client that has to make one more request to discover it finished is
        // a client polling an empty page forever. `toPage` decides it, because
        // it is the thing that knows whether a row was held back.
        next: page.nextCursor,
      })
    })
  },
})

/** The handles for these author ids, in one query. */
async function authorsFor(ids: number[]): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))]
  if (wanted.length === 0)
    return new Map()

  const rows: any[] = await db
    .selectFrom('users')
    .select(['id', 'handle'])
    .where('id', 'in', wanted)
    .execute()

  return new Map(rows.map(row => [Number(row.id), String(row.handle)]))
}

/** One pull request, as the list reports it. */
function shape(row: any, authors: Map<number, string>): Record<string, unknown> {
  return {
    number: Number(row.number),
    title: String(row.title ?? ''),
    state: String(row.state ?? ''),
    draft: Boolean(row.draft),
    author: authors.get(Number(row.author_id)) ?? (row.external_author ? String(row.external_author) : null),
    base_branch: String(row.base_branch ?? ''),
    head_branch: String(row.head_branch ?? ''),
    head_sha: String(row.head_sha ?? ''),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    changed_files: Number(row.changed_files ?? 0),
    // Present so a caller can build `pr checkout` and the stack view without a
    // second request per row.
    stack_parent: row.stack_parent_id ? Number(row.stack_parent_id) : null,
    created_at: row.created_at ? String(row.created_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  }
}
