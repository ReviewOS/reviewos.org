import type { KeysetSegment } from './listing'
import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import {
  encodeCursor,
  keysetPlan,
  MATCH_LIMIT,
  NONE,
  nextCursor,
  parseIssueQuery,
  SORT_COLUMNS,
  SORT_VALUE_TYPES,
  statesFor,
} from './listing'

/**
 * List a repository's issues.
 *
 * What a query means, and where the next page starts, is in `./listing` and
 * tested there. This assembles the query and hands back the rows.
 *
 * Pull requests are excluded. They share the numbering sequence and the table,
 * but a list of issues that quietly includes them is a list nobody asked for.
 *
 * **Everything here is an `AND` of single-column predicates, deliberately.** The
 * query builder ignores the expression-callback form of `where` outright -
 * `where(eb => ...)` returns the builder unchanged, so a filter written that way
 * silently matches everything - and its raw-fragment form drops bound values on
 * Postgres. A filter that quietly fails open is worse than one that is not
 * offered, so the relation filters resolve their ids in a separate query and
 * come back as a plain `whereIn`.
 *
 * Paging follows the same rule rather than working around it. A keyset boundary
 * over a column that ties is `col < v OR (col = v AND id < i)`, and the `OR` is
 * exactly what cannot be written - so `keysetPlan` splits it along the `OR` into
 * segments that are each an `AND`, and they run in order until the page is full.
 * One query when the page falls inside a segment, two when it straddles a
 * boundary, and the same rows in the same order either way.
 */
export default new Action({
  name: 'ListIssues',
  description: 'List the issues on a repository',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const query = parseIssueQuery(request.all?.() ?? {})
    const empty = () => response.json({ issues: [], next: null })

    // The filters, applied to a fresh builder each time. A segment is its own
    // query, so it needs its own copy: this builder appends clauses to a string
    // in call order rather than composing them, and reusing one across two
    // segments would stack the second segment's boundary on top of the first's.
    const filters: Array<(builder: any) => any> = []
    const scope = (): any => {
      let builder = db
        .selectFrom('issues')
        .where('issues.repository_id', '=', repository.id)
        .where('issues.is_pull_request', '=', false)

      for (const filter of filters)
        builder = filter(builder)

      return builder
    }

    const states = statesFor(query.state)
    if (states)
      filters.push(builder => builder.where('issues.state', 'in', states))

    if (query.author) {
      const author = await db
        .selectFrom('users')
        .select(['id'])
        .where('handle', '=', query.author)
        .executeTakeFirst()

      // An author who does not exist matches nothing rather than being ignored:
      // silently widening a filter shows people the rows they filtered out.
      if (!author)
        return empty()

      filters.push(builder => builder.where('issues.author_id', '=', Number(author.id)))
    }

    if (query.assignee === NONE) {
      const assigned = await db
        .selectFrom('issue_assignees')
        .innerJoin('issues', 'issues.id', '=', 'issue_assignees.issue_id')
        .select(['issue_assignees.issue_id as issue_id'])
        .where('issues.repository_id', '=', repository.id)
        .execute()

      const ids = [...new Set(assigned.map((row: any) => Number(row.issue_id)))]
      if (ids.length > 0)
        filters.push(builder => builder.whereNotIn('issues.id', ids))
    }
    else if (query.assignee) {
      const assignee = await db
        .selectFrom('users')
        .select(['id'])
        .where('handle', '=', query.assignee)
        .executeTakeFirst()

      if (!assignee)
        return empty()

      const assigned = await db
        .selectFrom('issue_assignees')
        .select(['issue_id'])
        .where('user_id', '=', Number(assignee.id))
        .execute()

      const ids = [...new Set(assigned.map((row: any) => Number(row.issue_id)))]
      if (ids.length === 0)
        return empty()

      filters.push(builder => builder.whereIn('issues.id', ids))
    }

    if (query.milestone === NONE) {
      filters.push(builder => builder.whereNull('issues.milestone_id'))
    }
    else if (query.milestone) {
      const milestone = await db
        .selectFrom('milestones')
        .select(['id'])
        .where('repository_id', '=', repository.id)
        .where('title', '=', query.milestone)
        .executeTakeFirst()

      if (!milestone)
        return empty()

      filters.push(builder => builder.where('issues.milestone_id', '=', Number(milestone.id)))
    }

    // Every named label has to be present, not any of them: "bug and
    // regression" is the question somebody naming two is asking. Intersecting
    // per label is what makes it an AND.
    for (const label of query.labels) {
      const tagged = await db
        .selectFrom('issue_labels')
        .innerJoin('repository_labels', 'repository_labels.id', '=', 'issue_labels.label_id')
        .select(['issue_labels.issue_id as issue_id'])
        .where('repository_labels.repository_id', '=', repository.id)
        .where('repository_labels.name', '=', label)
        .execute()

      const ids = [...new Set(tagged.map((row: any) => Number(row.issue_id)))]
      if (ids.length === 0)
        return empty()

      filters.push(builder => builder.whereIn('issues.id', ids))
    }

    if (query.search) {
      // Title and body are two columns, so matching either is an `OR`, and an
      // `OR` at this level would have to be grouped or it would swallow every
      // filter above it. Resolved as ids instead. Full-text search is phase 6's
      // job; this is the substring match people expect from a list box.
      const pattern = `%${query.search.replace(/[\\%_]/g, character => `\\${character}`)}%`
      // `limit` last, and never before a `where`. This builder appends clauses
      // in call order rather than composing them, so a `where` added after a
      // `limit` lands after `LIMIT` in the SQL and Postgres rejects the whole
      // statement.
      const scoped = (column: 'title' | 'body') => db
        .selectFrom('issues')
        .select(['id'])
        .where('repository_id', '=', repository.id)
        .where('is_pull_request', '=', false)
        .whereILike(column, pattern)
        .limit(MATCH_LIMIT)

      const [byTitle, byBody] = await Promise.all([
        scoped('title').execute(),
        scoped('body').execute(),
      ])

      const ids = [...new Set([...byTitle, ...byBody].map((row: any) => Number(row.id)))]
      if (ids.length === 0)
        return empty()

      filters.push(builder => builder.whereIn('issues.id', ids))
    }

    const direction = query.descending ? 'desc' : 'asc'
    const column = `issues.${SORT_COLUMNS[query.sort]}`
    const after = query.descending ? '<' : '>'

    /**
     * A value from the cursor, as the column will take it.
     *
     * The cursor travels as text, so a comment count comes back as `'3'`. Bound
     * against an integer column that is a type error on Postgres rather than a
     * comparison, and the error is at the bottom of a page load somebody was
     * expecting rows from.
     */
    const bound = (value: string): string | number =>
      SORT_VALUE_TYPES[query.sort] === 'number' ? Number(value) : value

    /** One segment of the plan, as a query, limited to what is still needed. */
    const run = async (segment: KeysetSegment, remaining: number): Promise<any[]> => {
      let builder = scope()
      // Within a tie the sort column is fixed, so the id is the only thing left
      // to order by. Everywhere else the column leads and the id breaks ties,
      // which is what stops a page boundary landing inside one.
      let byId = false

      switch (segment.kind) {
        case 'all':
          break

        case 'afterId':
          builder = builder.where('issues.id', after, segment.afterId)
          byId = true
          break

        case 'tie':
          builder = segment.value === null
            ? builder.whereNull(column)
            : builder.where(column, '=', bound(segment.value))
          builder = builder.where('issues.id', after, segment.afterId)
          byId = true
          break

        case 'beyond':
          builder = builder.where(column, after, bound(segment.value))
          break

        case 'nulls':
          builder = builder.whereNull(column)
          byId = true
          break

        case 'nonNulls':
          builder = builder.whereNotNull(column)
          break
      }

      builder = builder
        .leftJoin('users', 'users.id', '=', 'issues.author_id')
        .select([
          'issues.id as id',
          'issues.number as number',
          'issues.title as title',
          'issues.state as state',
          'issues.state_reason as state_reason',
          'issues.comments_count as comments_count',
          'issues.created_at as created_at',
          'issues.updated_at as updated_at',
          'issues.external_author as external_author',
          'users.handle as handle',
        ])

      if (!byId)
        builder = builder.orderBy(column, direction)

      // `limit` last, and never before a `where`. This builder appends clauses
      // in call order rather than composing them, so a `where` added after a
      // `limit` lands after `LIMIT` in the SQL and Postgres rejects the whole
      // statement.
      return await builder
        .orderBy('issues.id', direction)
        .limit(remaining)
        .execute()
    }

    const found: any[] = []
    for (const segment of keysetPlan(query)) {
      if (found.length >= query.limit)
        break

      found.push(...await run(segment, query.limit - found.length))
    }

    const cursor = nextCursor(found, query)

    return response.json({
      issues: found.map((row: any) => ({
        number: Number(row.number),
        title: String(row.title),
        state: String(row.state),
        state_reason: row.state_reason ?? null,
        comments: Number(row.comments_count ?? 0),
        author: row.handle ?? row.external_author ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      next: cursor ? encodeCursor(cursor) : null,
    })
  },
})
