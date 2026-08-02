import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { encodeCursor, isPageable, MATCH_LIMIT, NONE, nextCursor, parseIssueQuery, SORT_COLUMNS, statesFor } from './listing'

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

    let rows = db
      .selectFrom('issues')
      .where('issues.repository_id', '=', repository.id)
      .where('issues.is_pull_request', '=', false)

    const states = statesFor(query.state)
    if (states)
      rows = rows.where('issues.state', 'in', states)

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

      rows = rows.where('issues.author_id', '=', Number(author.id))
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
        rows = rows.whereNotIn('issues.id', ids)
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

      rows = rows.whereIn('issues.id', ids)
    }

    if (query.milestone === NONE) {
      rows = rows.whereNull('issues.milestone_id')
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

      rows = rows.where('issues.milestone_id', '=', Number(milestone.id))
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

      rows = rows.whereIn('issues.id', ids)
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

      rows = rows.whereIn('issues.id', ids)
    }

    const direction = query.descending ? 'desc' : 'asc'

    // Paged on the id, which for the creation order *is* the order: ids are
    // handed out as issues are opened, so it is the sort key and unique at
    // once, and no tiebreak has to travel in the cursor. `nextCursor` refuses to
    // issue one for the sorts where that is not true.
    if (query.cursor && isPageable(query.sort))
      rows = rows.where('issues.id', query.descending ? '<' : '>', query.cursor.id)

    const found = await rows
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
      .orderBy(`issues.${SORT_COLUMNS[query.sort]}`, direction)
      // Always last, so a page boundary never falls inside a tie.
      .orderBy('issues.id', direction)
      .limit(query.limit)
      .execute()

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
