/**
 * What is waiting on you, and what you are waiting on.
 *
 * A repository list as a landing page is a file browser's idea of a home
 * screen. The question somebody actually opens a forge to answer is "what needs
 * me", and every forge makes them assemble it out of notification email.
 *
 * The ordering is the whole feature, so it is a pure function over values and
 * it is written down rather than implied. Two properties matter more than the
 * exact numbers:
 *
 * - **It is explainable.** A queue that reorders itself by a formula nobody can
 *   state is a queue people stop trusting and go back to reading email. Each
 *   entry can say why it is where it is, in one phrase.
 * - **It is stable.** Two reloads a second apart must not shuffle the list. The
 *   tie-break is the pull request's own number, which never changes, rather
 *   than anything derived from the clock.
 */

/** One pull request in somebody's queue. */
export interface QueueEntry {
  pullRequestId: number
  number: number
  title: string
  owner: string
  repository: string
  authorHandle: string
  /** When the review was asked for, or the pull request opened. ISO 8601. */
  waitingSince: string
  draft: boolean
  /**
   * How many people were asked and have not answered.
   *
   * One means nobody else can unblock this. It is the difference between a
   * request that is genuinely stuck on you and one where four other people
   * were asked the same thing.
   */
  outstandingReviewers: number
  /** Approvals already in. A pull request that can merge is not blocked on you. */
  approvals: number
}

/** An hour, in milliseconds. The unit the queue thinks in. */
const HOUR = 3_600_000

/**
 * How long this has been waiting, in hours. Never negative.
 *
 * A clock skew between the database and the process would otherwise produce a
 * negative age that sorts a fresh request above a week-old one.
 */
export function hoursWaiting(entry: Pick<QueueEntry, 'waitingSince'>, now: number): number {
  const since = Date.parse(entry.waitingSince)
  if (Number.isNaN(since))
    return 0

  return Math.max(0, (now - since) / HOUR)
}

/**
 * Where an entry sits, as a number. Higher is more urgent.
 *
 * Age, weighted by how blocked the author is. Three adjustments, and no more,
 * because every extra term is another thing a reader cannot hold in their head
 * when the order surprises them:
 *
 * - **A draft is not asking.** It sorts below everything, whatever its age.
 *   Somebody who has not marked their work ready has not asked for a review,
 *   and a draft ageing its way to the top of a queue is how a queue teaches
 *   people to ignore it.
 * - **Being the only reviewer doubles it.** Nobody else can unblock this. Four
 *   people asked the same question is a slower kind of stuck.
 * - **An approval halves it.** The pull request can move without you, so your
 *   answer is worth having and is no longer the thing in the way.
 */
export function waitingScore(entry: QueueEntry, now: number): number {
  if (entry.draft)
    return -1

  const hours = hoursWaiting(entry, now)
  const alone = entry.outstandingReviewers <= 1 ? 2 : 1
  const unblocked = entry.approvals > 0 ? 0.5 : 1

  return hours * alone * unblocked
}

/**
 * Why an entry is where it is, in a phrase.
 *
 * Rendered beside it. A queue that cannot explain its own order is a queue
 * people route around, and the explanation costs one span.
 */
export function waitingReason(entry: QueueEntry, now: number): string {
  if (entry.draft)
    return 'draft, not asking yet'

  const hours = hoursWaiting(entry, now)
  const age = hours < 1
    ? 'just now'
    : hours < 24
      ? `${Math.floor(hours)}h`
      : `${Math.floor(hours / 24)}d`

  if (entry.approvals > 0)
    return `${age}, already approved by somebody`

  if (entry.outstandingReviewers <= 1)
    return `${age}, only you`

  return `${age}, ${entry.outstandingReviewers} asked`
}

/**
 * The queue, ordered.
 *
 * Sorted on a copy: the caller's array is theirs, and a loader that handed the
 * same array to two callers would have the second one see the first one's
 * order. Ties break on the pull request number so two reloads a second apart
 * produce the same list.
 */
export function orderQueue(entries: readonly QueueEntry[], now: number): QueueEntry[] {
  return [...entries].sort((left, right) => {
    const difference = waitingScore(right, now) - waitingScore(left, now)
    if (difference !== 0)
      return difference

    return left.number - right.number
  })
}

/**
 * Everything waiting on one person, and everything they are waiting on.
 *
 * Two queries rather than one with a union: the two halves ask genuinely
 * different questions - "who was asked and has not answered" against "whose
 * pull requests have an unanswered request on them" - and a single clever query
 * for both is how one of them silently stops being right.
 *
 * `responded_at` is what makes a request outstanding. The row is kept when a
 * review lands rather than deleted, so "was this person ever asked" survives;
 * that means every read here has to say `is null` and a read that forgets to
 * shows a queue that never empties.
 */
export async function reviewQueue(userId: number, now: number): Promise<{
  waitingOnYou: QueueEntry[]
  waitingOnOthers: QueueEntry[]
}> {
  const [asked, authored] = await Promise.all([
    queueRows({ reviewerId: userId }),
    queueRows({ authorId: userId }),
  ])

  return {
    waitingOnYou: orderQueue(asked, now),
    waitingOnOthers: orderQueue(authored, now),
  }
}

/**
 * How many pull requests are genuinely waiting on one person.
 *
 * The number on the navigation item, so it lives beside the queries it must
 * agree with. It counts the "waiting on you" half only - the other half is
 * waiting on somebody else, which is not a number to interrupt anybody with -
 * and it excludes drafts, deliberately diverging from the list: the queue
 * *shows* a draft with "not asking yet" beside it, and a badge has no room for
 * that sentence, so a draft in the count would read as a request that does not
 * exist.
 *
 * The same `responded_at IS NULL` rule as `queueRows`, for the same reason: a
 * count that forgets it never reaches zero.
 */
export async function outstandingRequestCount(userId: number): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0)
    return 0

  const rows: any = await db.unsafe(
    `SELECT COUNT(DISTINCT "p"."id") AS "waiting"
     FROM "pull_request_reviewers" "r"
     JOIN "pull_requests" "p" ON "p"."id" = "r"."pull_request_id"
     WHERE "r"."reviewer_id" = $1
       AND "r"."responded_at" IS NULL
       AND "p"."state" = 'open'
       AND NOT "p"."draft"`,
    [userId],
  ).execute()

  const first = Array.isArray(rows) ? rows[0] : undefined
  return Number(first?.waiting ?? 0)
}

/**
 * The rows behind one half of the queue.
 *
 * Written out rather than built, because the shape is a three way join with two
 * correlated counts and the builder has no vocabulary for the counts. Both
 * variants are the same statement with one predicate swapped, so they cannot
 * drift in the parts that are not the difference between them. Every value is
 * bound; the only thing interpolated is a predicate chosen from this file.
 */
async function queueRows(scope: { reviewerId?: number, authorId?: number }): Promise<QueueEntry[]> {
  const id = scope.reviewerId ?? scope.authorId
  if (!id)
    return []

  // The reviewer's half is bounded by who was asked; the author's half by who
  // opened it, still requiring an outstanding request so a pull request nobody
  // has been asked to look at is not reported as waiting on anybody.
  const predicate = scope.reviewerId
    ? `"r"."reviewer_id" = $1`
    : `"p"."author_id" = $1`

  const rows: any = await db.unsafe(
    `SELECT DISTINCT ON ("p"."id")
       "p"."id" AS "pull_request_id",
       "p"."number" AS "number",
       "p"."title" AS "title",
       "p"."draft" AS "draft",
       "r"."created_at" AS "waiting_since",
       "repo"."name" AS "repository",
       "owner"."handle" AS "owner",
       "author"."handle" AS "author_handle",
       (SELECT COUNT(*) FROM "pull_request_reviewers" "o"
          WHERE "o"."pull_request_id" = "p"."id" AND "o"."responded_at" IS NULL) AS "outstanding",
       (SELECT COUNT(*) FROM "pull_request_reviews" "v"
          WHERE "v"."pull_request_id" = "p"."id" AND "v"."state" = 'approved') AS "approvals"
     FROM "pull_request_reviewers" "r"
     JOIN "pull_requests" "p" ON "p"."id" = "r"."pull_request_id"
     JOIN "repositories" "repo" ON "repo"."id" = "p"."repository_id"
     LEFT JOIN "users" "owner" ON "owner"."id" = "repo"."owner_id" AND "repo"."owner_type" = 'user'
     LEFT JOIN "users" "author" ON "author"."id" = "p"."author_id"
     WHERE ${predicate}
       AND "r"."responded_at" IS NULL
       AND "p"."state" = 'open'
     ORDER BY "p"."id", "r"."created_at" ASC`,
    [id],
  ).execute()

  return (Array.isArray(rows) ? rows : []).map((row: any): QueueEntry => ({
    pullRequestId: Number(row.pull_request_id),
    number: Number(row.number),
    title: String(row.title ?? ''),
    owner: String(row.owner ?? ''),
    repository: String(row.repository ?? ''),
    authorHandle: String(row.author_handle ?? ''),
    waitingSince: row.waiting_since instanceof Date
      ? row.waiting_since.toISOString()
      : String(row.waiting_since ?? ''),
    draft: Boolean(row.draft),
    outstandingReviewers: Number(row.outstanding ?? 0),
    approvals: Number(row.approvals ?? 0),
  }))
}
