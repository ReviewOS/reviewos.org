/**
 * The denormalized counters, recomputed from the rows they count.
 *
 * `repositories.open_issues_count` and `issues.comments_count` exist so a list
 * does not have to run a `COUNT` per row. Every writer is supposed to keep them
 * in step with the thing they count, and every writer in this application did
 * it the same way:
 *
 *     .set(eb => ({ open_issues_count: eb('open_issues_count', '+', 1) }))
 *
 * which emits `UPDATE "repositories" SET  WHERE "id" = $1`. An empty `SET`.
 * The query builder drops the expression-callback form silently - the same
 * defect its `where` had, and the reason `ListIssuesAction` is written entirely
 * out of single-column predicates. Postgres rejects the statement, the error is
 * swallowed by the `try` around it or surfaces as a failed request nobody
 * connected to a counter, and **not one counter in this product has ever
 * moved**. Every repository has said `0 open issues` since the day it was
 * created, and every issue has said `0 comments`.
 *
 * So they are recomputed rather than adjusted. It costs one indexed `COUNT`
 * per mutation instead of an arithmetic update, and it buys three things worth
 * more than that:
 *
 * - It is **correct under concurrency**. Two people closing two issues at once
 *   cannot both read 5 and write 4.
 * - It is **self-healing**. The first close on a repository whose counter has
 *   been wrong since it was created fixes the counter.
 * - It **cannot drift**, so nothing has to be right in every one of seven call
 *   sites forever.
 *
 * A counter is only worth denormalizing when the query it saves is expensive,
 * and this one is a count over an index. If that ever stops being true the
 * answer is a materialized count, not an increment nobody can verify.
 */

/**
 * Recompute a repository's open issue count.
 *
 * Issues only, not pull requests: they share the table and the numbering, and
 * `open_issues_count` on a repository has always meant issues.
 */
export async function recountOpenIssues(repositoryId: number): Promise<number | null> {
  if (!Number.isFinite(repositoryId) || repositoryId <= 0)
    return null

  try {
    const row = await db
      .selectFrom('issues')
      .select(db.fn.count('id').as('n'))
      .where('repository_id', '=', repositoryId)
      .where('is_pull_request', '=', false)
      .where('state', '=', 'open')
      .executeTakeFirst()

    const count = Number(row?.n ?? 0)

    await db
      .updateTable('repositories')
      .set({ open_issues_count: count })
      .where('id', '=', repositoryId)
      .execute()

    return count
  }
  catch {
    // A wrong count is a wrong number on a list. It is never worth failing the
    // close, the comment or the merge that prompted it.
    return null
  }
}

/** Recompute a repository's star count, for the same reasons as above. */
export async function recountStars(repositoryId: number): Promise<number | null> {
  return await recount('stars', 'repository_id', repositoryId, 'stars_count')
}

/** Recompute how many forks point back at a repository. */
export async function recountForks(repositoryId: number): Promise<number | null> {
  return await recount('repositories', 'parent_id', repositoryId, 'forks_count')
}

/**
 * One count over an index, written back to one column on `repositories`.
 *
 * Shared rather than repeated because the shape is identical and the failure
 * mode is not: a counter that is wrong on one list is a cosmetic bug, and a
 * counter that is wrong because one of three near-identical functions was
 * edited and the others were not is the bug that takes an afternoon to find.
 */
async function recount(
  table: 'stars' | 'repositories',
  column: string,
  repositoryId: number,
  target: string,
): Promise<number | null> {
  if (!Number.isFinite(repositoryId) || repositoryId <= 0)
    return null

  try {
    const row = await db
      .selectFrom(table as any)
      .select(db.fn.count('id').as('n'))
      .where(column as any, '=', repositoryId)
      .executeTakeFirst()

    const count = Number(row?.n ?? 0)

    await db
      .updateTable('repositories')
      .set({ [target]: count })
      .where('id', '=', repositoryId)
      .execute()

    return count
  }
  catch {
    return null
  }
}

/** Recompute one issue's comment count. */
export async function recountComments(issueId: number): Promise<number | null> {
  if (!Number.isFinite(issueId) || issueId <= 0)
    return null

  try {
    const row = await db
      .selectFrom('issue_comments')
      .select(db.fn.count('id').as('n'))
      .where('commentable_type', '=', 'issue')
      .where('commentable_id', '=', issueId)
      .executeTakeFirst()

    const count = Number(row?.n ?? 0)

    await db
      .updateTable('issues')
      .set({ comments_count: count })
      .where('id', '=', issueId)
      .execute()

    return count
  }
  catch {
    return null
  }
}
