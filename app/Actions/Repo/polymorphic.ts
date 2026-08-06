/**
 * The rows a foreign key cannot reach.
 *
 * Everything that hangs off a repository by a plain `repository_id` goes when
 * the repository goes, because the constraint says so. A polymorphic row does
 * not: `issue_comments.commentable_id` is an issue *or* a pull request,
 * decided per row by `commentable_type`, and no foreign key can express that -
 * the constraint would name one table and reject every row pointing at the
 * other.
 *
 * That is not a gap in the schema, it is what polymorphism costs. So this is
 * the one place the application still deletes rows on the database's behalf,
 * and it is deliberately a short explicit list rather than a walk of
 * `information_schema`: five tables somebody can read and check, not a graph
 * that silently decides what a delete means.
 *
 * It was found by deleting a repository and looking: the issue went, the
 * comment on it stayed. Before the schema was regenerated from the models,
 * `commentable_id` carried `REFERENCES issues(id)` - a foreign key on a
 * polymorphic column, which would have rejected a comment on a pull request -
 * and the old delete walked that wrong constraint to find these rows. Removing
 * it was right. Nothing replacing it was not.
 *
 * `audit_events` and `activities` are polymorphic too and are deliberately left
 * alone. The audit row saying this repository was deleted is written moments
 * before the delete, and a log that disappears with its subject is a log that
 * cannot tell you what happened to it.
 */

import { deleteWhereIn, IN_CHUNK } from '../Support/rows'

export interface PolymorphicSweep {
  ok: boolean
  /** Table name to rows removed. Only tables that had something to remove. */
  removed: Array<{ table: string, rows: number }>
  error?: string
}

/**
 * Remove the polymorphic rows belonging to a repository.
 *
 * Runs *before* the repository row is deleted, because it needs the ids of the
 * issues and pull requests the cascade is about to remove. Afterwards there is
 * nothing left to ask.
 */
export async function sweepPolymorphic(repositoryId: number): Promise<PolymorphicSweep> {
  const removed: PolymorphicSweep['removed'] = []

  if (!Number.isFinite(repositoryId) || repositoryId <= 0)
    return { ok: false, removed, error: 'Not a repository id' }

  try {
    const issues = await idsWhere('issues', 'repository_id', repositoryId)
    const pulls = await idsWhere('pull_requests', 'repository_id', repositoryId)
    const threads = await idsIn('review_threads', 'pull_request_id', pulls)

    // Comments on both, and the review comments under those threads, because
    // reactions point at all three.
    const comments = [
      ...await idsIn('issue_comments', 'commentable_id', issues, { commentable_type: 'issue' }),
      ...await idsIn('issue_comments', 'commentable_id', pulls, { commentable_type: 'pull_request' }),
    ]
    const reviewComments = await idsIn('review_comments', 'review_thread_id', threads)

    // A reaction points at an issue, a comment on one, or a review comment.
    // Each is a different subject type against a different set of ids, so each
    // is its own delete rather than one over a merged list - the ids come from
    // different tables and would otherwise collide.
    const reactions
      = await removeFor('reactions', 'subject_id', 'subject_type', 'issue', issues)
        + await removeFor('reactions', 'subject_id', 'subject_type', 'issue_comment', comments)
        + await removeFor('reactions', 'subject_id', 'subject_type', 'review_comment', reviewComments)

    if (reactions > 0)
      removed.push({ table: 'reactions', rows: reactions })

    const timeline
      = await removeFor('timeline_entries', 'subject_id', 'subject_type', 'issue', issues)
        + await removeFor('timeline_entries', 'subject_id', 'subject_type', 'pull_request', pulls)

    if (timeline > 0)
      removed.push({ table: 'timeline_entries', rows: timeline })

    // Notification rows also point at the repository itself, which is the one
    // subject that is not reached through an issue or a pull request.
    for (const table of ['notification_subscriptions', 'notification_mutes']) {
      const rows
        = await removeFor(table, 'subject_id', 'subject_type', 'repository', [repositoryId])
          + await removeFor(table, 'subject_id', 'subject_type', 'issue', issues)
          + await removeFor(table, 'subject_id', 'subject_type', 'pull_request', pulls)

      if (rows > 0)
        removed.push({ table, rows })
    }

    // Last, because the reactions above are found through them.
    const commentRows
      = await removeFor('issue_comments', 'commentable_id', 'commentable_type', 'issue', issues)
        + await removeFor('issue_comments', 'commentable_id', 'commentable_type', 'pull_request', pulls)

    if (commentRows > 0)
      removed.push({ table: 'issue_comments', rows: commentRows })

    return { ok: true, removed }
  }
  catch (error) {
    // Reported rather than swallowed: the caller has not moved anything on disk
    // yet, so a failure here is a delete that did not happen, which is the
    // right outcome for a delete that cannot complete.
    return { ok: false, removed, error: `Could not clear the polymorphic rows: ${error}` }
  }
}

/** Delete the rows of one subject type whose id is in `ids`. */
async function removeFor(
  table: string,
  idColumn: string,
  typeColumn: string,
  type: string,
  ids: number[],
): Promise<number> {
  if (ids.length === 0)
    return 0

  let rows = 0
  for (const chunk of chunked(ids))
    rows += await deleteWhereIn(table, idColumn, chunk, { [typeColumn]: type })

  return rows
}

async function idsWhere(table: string, column: string, value: number): Promise<number[]> {
  const rows: any[] = await db
    .selectFrom(table as any)
    .select(['id'] as any)
    .where(column as any, '=', value)
    .execute()

  return rows.map(row => Number(row.id))
}

async function idsIn(
  table: string,
  column: string,
  values: number[],
  and: Record<string, string> = {},
): Promise<number[]> {
  if (values.length === 0)
    return []

  const ids: number[] = []

  for (const chunk of chunked(values)) {
    let query = db.selectFrom(table as any).select(['id'] as any).where(column as any, 'in', chunk)

    for (const [key, value] of Object.entries(and))
      query = query.where(key as any, '=', value)

    for (const row of (await query.execute()) as any[])
      ids.push(Number(row.id))
  }

  return ids
}

function* chunked(values: number[]): Generator<number[]> {
  for (let index = 0; index < values.length; index += IN_CHUNK)
    yield values.slice(index, index + IN_CHUNK)
}
