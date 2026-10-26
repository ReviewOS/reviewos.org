import { db } from '@stacksjs/database'

/**
 * The `issues` row that stands behind a pull request.
 *
 * A pull request gets one. `issues.is_pull_request` has existed since the
 * table was created and nothing ever set it, while `ListIssuesAction` and
 * `Repo/counters.ts` both already filter it out - half a design, waiting for
 * the rows that were never written. This writes them.
 *
 * ## What it is for
 *
 * Not the timeline, and not reactions: `timeline_entries.subject_type` and
 * `reactions.subject_type` are already polymorphic over `issue | pull_request`
 * and never needed this. What needs it is every path that resolves a number
 * through the `issues` table and finds nothing for a change - the comment
 * action is the one people notice, because a pull request conversation simply
 * had nowhere to go. It is also the shape GitHub's API has, which is what
 * `Mirror/metadata.ts` is reading when it imports an issue and a pull request
 * that share one number.
 *
 * ## The cost, stated plainly
 *
 * Title, body and state now live in two tables, and a second copy is a second
 * thing to get wrong. There is no foreign key tying them: the pair is matched
 * on `(repository_id, number)`, which is uniquely indexed on both sides, so
 * the join is exact but nothing in the database enforces that the two agree.
 *
 * That is why every write goes through here rather than being inlined at each
 * call site. Fifteen places update `pull_requests`; the ones that touch a
 * shadowed column call `syncIssueRow` immediately after, and a new one that
 * forgets is the way this breaks. If that happens often enough to matter, the
 * answer is to stop copying content and let the row carry identity alone.
 */

/** The columns the shadow row mirrors. Everything else is the pull request's. */
export interface IssueRowInput {
  repositoryId: number
  number: number
  title?: string | null
  body?: string | null
  authorId?: number | null
  state?: string | null
  closedAt?: string | null
  closedById?: number | null
  locked?: boolean | null
}

/**
 * `issues.state` is an enum that knows nothing about merging.
 *
 * A merged pull request is closed as far as the issues table is concerned,
 * and saying so is better than writing a value the column does not accept and
 * failing the merge over a shadow row.
 */
function issueState(state: string | null | undefined): string {
  const value = String(state ?? 'open')

  return value === 'open' ? 'open' : 'closed'
}

/**
 * Write or update the row for one pull request.
 *
 * Never throws. A pull request that exists with no shadow row is a missing
 * conversation; a pull request that could not be opened because its shadow row
 * failed is a lost change, and the second is worse. Callers treat this the way
 * `recordCrossReferences` is treated at the same call sites, and for the same
 * reason.
 */
export async function syncIssueRow(input: IssueRowInput): Promise<void> {
  try {
    const existing = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', input.repositoryId)
      .where('number', '=', input.number)
      .executeTakeFirst()

    const values: Record<string, unknown> = {
      is_pull_request: true,
      state: issueState(input.state),
    }

    // Only what the caller actually knows. A state transition does not carry a
    // title, and writing `undefined` over a good one would be worse than
    // leaving it: the row is a mirror, not a form submission.
    if (input.title !== undefined)
      values.title = String(input.title ?? '')
    if (input.body !== undefined)
      values.body = input.body === null ? null : String(input.body)
    if (input.authorId !== undefined)
      values.author_id = input.authorId
    if (input.closedAt !== undefined)
      values.closed_at = input.closedAt
    if (input.closedById !== undefined)
      values.closed_by_id = input.closedById
    if (input.locked !== undefined)
      values.locked = Boolean(input.locked)

    if (existing?.id) {
      await db.updateTable('issues').set(values).where('id', '=', existing.id).execute()

      return
    }

    await db
      .insertInto('issues')
      .values({
        repository_id: input.repositoryId,
        number: input.number,
        /*
         * A title is required on this table and a change always has one, but
         * an empty string is still better than refusing the row: the pull
         * request is what gets read, and this exists so a number resolves.
         */
        title: String(input.title ?? ''),
        ...values,
      })
      .execute()
  }
  catch (error) {
    console.error(`[pull] could not sync the issues row for #${input.number}:`, error)
  }
}

/**
 * Drop the row, for a pull request that is going away.
 *
 * Deleting a pull request without this leaves a number that resolves to a
 * conversation nobody can reach from anywhere, which is worse than no row.
 */
export async function removeIssueRow(repositoryId: number, number: number): Promise<void> {
  try {
    await db
      .deleteFrom('issues')
      .where('repository_id', '=', repositoryId)
      .where('number', '=', number)
      .where('is_pull_request', '=', true)
      .execute()
  }
  catch (error) {
    console.error(`[pull] could not remove the issues row for #${number}:`, error)
  }
}
