/**
 * Who a repository is waiting on, for the people who can do something about it.
 *
 * The queue answers "what needs me"; this answers the maintainer's question,
 * which is "who is everything stuck behind" - and it is information, not a
 * leaderboard. That distinction is in the ordering: rows come oldest-wait
 * first, because the request that has waited longest is the one to go and ask
 * about, and ordering by count would rank people instead - a table that reads
 * as "who is slowest" gets routed around, and then nobody looks at it at all.
 *
 * The same reading rules as the queue and the badge: `responded_at IS NULL` is
 * what makes a request outstanding, an open pull request is the only kind
 * waiting on anybody, and a draft is not asking.
 */

import { agePhrase, hoursWaiting } from './queue'

export interface ReviewerLoadRow {
  handle: string
  /** Open, non-draft pull requests with an unanswered request on this person. */
  waiting: number
  /** When the longest-waiting of them was asked. ISO 8601. */
  oldestSince: string
}

/** One row per reviewer this repository is waiting on, oldest wait first. */
export async function reviewerLoadFor(repositoryId: number): Promise<ReviewerLoadRow[]> {
  if (!Number.isInteger(repositoryId) || repositoryId <= 0)
    return []

  const rows = await db.unsafe(
    `SELECT
      "u"."handle" AS "handle",
      COUNT(DISTINCT "p"."id") AS "waiting",
      MIN("r"."created_at") AS "oldest"
    FROM "pull_request_reviewers" "r"
    JOIN "pull_requests" "p" ON "p"."id" = "r"."pull_request_id"
    JOIN "users" "u" ON "u"."id" = "r"."reviewer_id"
    WHERE "p"."repository_id" = $1
      AND "r"."responded_at" IS NULL
      AND "p"."state" = 'open'
      AND NOT "p"."draft"
    GROUP BY "u"."handle"
    ORDER BY MIN("r"."created_at") ASC, "u"."handle" ASC`,
    [repositoryId],
  ).execute()

  return (Array.isArray(rows) ? rows : []).map((row: any): ReviewerLoadRow => ({
    handle: String(row.handle),
    waiting: Number(row.waiting ?? 0),
    oldestSince: row.oldest instanceof Date ? row.oldest.toISOString() : String(row.oldest ?? ''),
  }))
}

/**
 * One row, said in a phrase: `2 waiting, oldest 3d`.
 *
 * The queue's own age wording, so the two surfaces cannot describe the same
 * wait two ways.
 */
export function loadPhrase(row: ReviewerLoadRow, now: number): string {
  const count = row.waiting === 1 ? '1 waiting' : `${row.waiting} waiting`
  const age = agePhrase(hoursWaiting({ waitingSince: row.oldestSince }, now))

  return age === 'just now' ? `${count}, just asked` : `${count}, oldest ${age}`
}
