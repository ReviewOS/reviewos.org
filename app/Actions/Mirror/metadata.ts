/**
 * Deciding what a metadata sync should write.
 *
 * Pure, like `sync.ts` is for refs. It takes what upstream has and what this
 * database already holds, and returns the difference. The job does the writing,
 * so every rule here can be tested without a database or a token.
 */

import type { MappedIssue, MappedPull, MappedReviewComment } from './github'

/**
 * A row already here, identified the way its kind is identified.
 *
 * Issues and pull requests are known by number, which the mirror preserves
 * precisely so this works. Comments have no natural key and are known by the
 * upstream id stored on them.
 */
export interface Existing {
  id: number
  updatedAt?: string | null
}

export interface Plan<T> {
  create: T[]
  update: Array<{ id: number, incoming: T }>
}

/**
 * What to insert and what to update, for anything keyed by number.
 *
 * Nothing is ever deleted. An issue that vanished upstream - made private,
 * deleted by a moderator, lost in a repository transfer - has usually still
 * been read and linked to here, and removing it would break those links to
 * make the mirror tidier. A mirror is a record of what was there.
 */
export function planByNumber<T extends { number: number }>(
  incoming: readonly T[],
  existing: ReadonlyMap<number, Existing>,
): Plan<T> {
  const create: T[] = []
  const update: Array<{ id: number, incoming: T }> = []

  for (const item of incoming) {
    const found = existing.get(item.number)
    if (found === undefined) create.push(item)
    else update.push({ id: found.id, incoming: item })
  }

  return { create, update }
}

/** The same, for review comments, which are keyed by their upstream id. */
export function planByExternalId<T extends { externalId: number }>(
  incoming: readonly T[],
  existing: ReadonlyMap<number, Existing>,
): Plan<T> {
  const create: T[] = []
  const update: Array<{ id: number, incoming: T }> = []

  for (const item of incoming) {
    const found = existing.get(item.externalId)
    if (found === undefined) create.push(item)
    else update.push({ id: found.id, incoming: item })
  }

  return { create, update }
}

/**
 * The columns an issue row takes, whether it is being created or updated.
 *
 * `author_id` and `external_author` move together: exactly one of them is set,
 * because a linked account is a local author and an unlinked one is a name.
 * Setting both would make the interface choose, and it would choose wrong half
 * the time.
 */
export function issueRow(issue: MappedIssue, repositoryId: number): Record<string, unknown> {
  return {
    repository_id: repositoryId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    author_id: issue.attribution.userId,
    external_author: issue.attribution.userId === null ? issue.attribution.displayName : null,
    closed_at: issue.closedAt,
    is_pull_request: false,
  }
}

/**
 * `baseSha` is passed in rather than taken from the mapped pull, because the
 * commit worth storing is the one this repository holds - see
 * `resolveBaseShas`. Omitting the argument falls back to upstream's, which is
 * what a caller with no repository on disk (a test of the mapping) wants.
 */
export function pullRow(
  pull: MappedPull,
  repositoryId: number,
  baseSha?: string | null,
): Record<string, unknown> {
  return {
    repository_id: repositoryId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    // A pull request's local state vocabulary matches GitHub's once merged is
    // separated out, which `pullState` has already done.
    state: pull.state,
    draft: pull.draft,
    head_branch: pull.headRef,
    base_branch: pull.baseRef,
    // Without these the review screen has nothing to diff: the branch names
    // are upstream's, and the branches themselves are not fetched into a
    // mirror - the commits arrive under `refs/pull/<n>/head`, which is
    // reachable by sha and by nothing else here.
    head_sha: pull.headSha,
    base_sha: baseSha === undefined ? pull.baseSha : baseSha,
    author_id: pull.attribution.userId,
    external_author: pull.attribution.userId === null ? pull.attribution.displayName : null,
    merged_at: pull.mergedAt,
  }
}

export function reviewCommentRow(
  comment: MappedReviewComment,
  threadId: number,
): Record<string, unknown> {
  return {
    review_thread_id: threadId,
    body: comment.body,
    author_id: comment.attribution.userId,
    external_author: comment.attribution.userId === null ? comment.attribution.displayName : null,
    external_id: comment.externalId,
  }
}

/**
 * The thread a group of comments belongs to.
 *
 * The root comment carries the anchor: its path, line and side are the thread's.
 * Replies inherit them, and a reply that disagrees is not a second thread.
 */
export function threadRow(
  thread: readonly MappedReviewComment[],
  pullRequestId: number,
): Record<string, unknown> | null {
  const root = thread[0]
  if (!root) return null

  return {
    pull_request_id: pullRequestId,
    path: root.path,
    line: root.line,
    side: root.side,
    external_id: root.externalId,
  }
}

/**
 * Group review comments by the pull request they belong to.
 *
 * GitHub's repository-wide review-comment endpoint is one list across every
 * pull request, and the pull request number is only recoverable from the
 * comment's `pull_request_url`. Fetching per pull request instead would be one
 * request each, which on a repository with two thousand of them is the
 * difference between one sync and a rate limit.
 */
export function pullNumberOf(comment: { pull_request_url?: string }): number | null {
  const match = /\/pulls\/(\d+)(?:$|[/?#])/.exec(String(comment.pull_request_url ?? ''))
  if (!match) return null

  const number = Number(match[1])
  return Number.isFinite(number) ? number : null
}

/**
 * Whether a metadata sync is due.
 *
 * Metadata costs API calls against a shared rate limit, so it runs on its own,
 * slower cadence than the ref fetch rather than on every push. A repository
 * that receives a commit a minute should not spend its whole rate limit
 * re-reading a backlog that did not change.
 */
export function metadataDue(
  lastSyncedAt: string | null | undefined,
  intervalSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!lastSyncedAt) return true

  const last = Date.parse(lastSyncedAt)
  // An unparseable timestamp means the state is not trustworthy, and syncing
  // once too often is cheaper than never syncing again.
  if (!Number.isFinite(last)) return true

  return now.getTime() - last >= intervalSeconds * 1000
}

/**
 * How long to wait before the next metadata sync after a failure.
 *
 * Widening rather than fixed, because the common failures - a rate limit, a
 * repository gone private, a revoked token - are not fixed by retrying sooner,
 * and a mirror retrying every fifteen minutes forever is how one broken mirror
 * spends the rate limit of every working one.
 */
export function metadataBackoffSeconds(failures: number, base = 900): number {
  if (failures <= 0) return base

  // The exponent is bounded only to keep the arithmetic finite; the day clamp
  // below is the actual ceiling, and a tighter bound here would silently stop
  // the backoff short of it.
  const widened = base * 2 ** Math.min(failures, 20)
  // A day is the ceiling: past that the mirror is effectively off, and it
  // should still check daily in case whatever broke was fixed.
  return Math.min(widened, 24 * 60 * 60)
}
