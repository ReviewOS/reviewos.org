/**
 * Mapping GitHub's API shapes onto this forge's.
 *
 * Pure: it takes decoded JSON and returns rows. The fetching lives in
 * `github-client.ts`, so every mapping rule here is testable without a token,
 * a network, or a rate limit.
 *
 * The rule that shapes all of it: **numbers are preserved**. A mirrored `#123`
 * has to be `#123` here, because every reference anyone has ever written -
 * commit messages, changelogs, other issues, chat - points at that number. A
 * mirror that renumbers is a mirror whose cross-references all lie.
 */

export interface GitHubUser {
  login?: string
  id?: number
  type?: string
}

export interface GitHubIssue {
  number?: number
  title?: string
  body?: string | null
  state?: string
  user?: GitHubUser | null
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  labels?: Array<{ name?: string, color?: string } | string>
  /** GitHub returns pull requests from the issues endpoint too. */
  pull_request?: unknown
}

export interface GitHubPull {
  number?: number
  title?: string
  body?: string | null
  state?: string
  draft?: boolean
  merged_at?: string | null
  user?: GitHubUser | null
  created_at?: string
  updated_at?: string
  head?: { ref?: string, sha?: string }
  base?: { ref?: string, sha?: string }
}

export interface GitHubReviewComment {
  id?: number
  path?: string
  line?: number | null
  original_line?: number | null
  side?: string
  body?: string
  user?: GitHubUser | null
  created_at?: string
  pull_request_review_id?: number | null
  in_reply_to_id?: number | null
}

/** State as this forge records it. */
export type IssueState = 'open' | 'closed'
export type PullState = 'open' | 'closed' | 'merged'

/**
 * A pull request is merged or closed, and GitHub reports both as `closed`.
 *
 * Treating a merged pull request as merely closed loses the distinction the
 * review screen is built around, so `merged_at` decides.
 */
export function pullState(pull: GitHubPull): PullState {
  if (pull.merged_at) return 'merged'
  return pull.state === 'closed' ? 'closed' : 'open'
}

export function issueState(issue: GitHubIssue): IssueState {
  return issue.state === 'closed' ? 'closed' : 'open'
}

/**
 * Which diff side a review comment belongs to.
 *
 * GitHub says LEFT or RIGHT; anything else means the comment is not anchored to
 * a side and the right-hand side is the safe default, since that is where new
 * code lives and where an unanchored comment reads correctly.
 */
export function commentSide(comment: GitHubReviewComment): 'left' | 'right' {
  return String(comment.side ?? '').toUpperCase() === 'LEFT' ? 'left' : 'right'
}

/**
 * The line a review comment is anchored to.
 *
 * `line` is the current position and `original_line` is where it was written.
 * Preferring `line` keeps a comment attached to the code as it is now; falling
 * back to `original_line` keeps an outdated comment visible somewhere sensible
 * rather than dropping it.
 */
export function commentLine(comment: GitHubReviewComment): number | null {
  const line = comment.line ?? comment.original_line
  return typeof line === 'number' && Number.isFinite(line) ? line : null
}

/**
 * Issues only, with pull requests filtered out.
 *
 * GitHub's issues endpoint returns pull requests as well, distinguished solely
 * by the presence of a `pull_request` key. Importing without this creates a
 * duplicate issue for every pull request, each holding the number a real issue
 * may already occupy.
 */
export function onlyIssues(items: readonly GitHubIssue[]): GitHubIssue[] {
  return items.filter(item => item.pull_request === undefined && typeof item.number === 'number')
}

export interface LabelRef {
  name: string
  color: string | null
}

/** Labels, in either shape GitHub returns them. */
export function normalizeLabels(labels: GitHubIssue['labels']): LabelRef[] {
  if (!Array.isArray(labels)) return []

  const seen = new Set<string>()
  const out: LabelRef[] = []

  for (const label of labels) {
    const name = typeof label === 'string' ? label : String(label?.name ?? '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, color: typeof label === 'string' ? null : (label?.color ?? null) })
  }

  return out
}

export interface Attribution {
  /** Local user id when the GitHub identity is linked, else null. */
  userId: number | null
  /** Shown when there is no local user, so the author is still visible. */
  displayName: string | null
}

/**
 * Who wrote something.
 *
 * When a GitHub account is not linked to a local user the comment is attributed
 * by display name only. It must never be silently assigned to a local account
 * that happens to share a handle: two different people with the same name is
 * ordinary, and putting words in someone's mouth is not a bug you can apologise
 * your way out of.
 */
export function attribute(user: GitHubUser | null | undefined, linked: ReadonlyMap<string, number>): Attribution {
  const login = String(user?.login ?? '').trim()
  if (!login) return { userId: null, displayName: null }

  const userId = linked.get(login.toLowerCase())
  return userId === undefined
    ? { userId: null, displayName: login }
    : { userId, displayName: login }
}

export interface MappedIssue {
  number: number
  title: string
  body: string
  state: IssueState
  labels: LabelRef[]
  attribution: Attribution
  createdAt: string | null
  closedAt: string | null
}

export function mapIssue(issue: GitHubIssue, linked: ReadonlyMap<string, number>): MappedIssue | null {
  if (typeof issue.number !== 'number') return null

  return {
    number: issue.number,
    title: String(issue.title ?? '').slice(0, 500),
    body: String(issue.body ?? ''),
    state: issueState(issue),
    labels: normalizeLabels(issue.labels),
    attribution: attribute(issue.user, linked),
    createdAt: issue.created_at ?? null,
    closedAt: issue.closed_at ?? null,
  }
}

export interface MappedPull {
  number: number
  title: string
  body: string
  state: PullState
  draft: boolean
  headRef: string | null
  baseRef: string | null
  attribution: Attribution
  createdAt: string | null
  mergedAt: string | null
}

export function mapPull(pull: GitHubPull, linked: ReadonlyMap<string, number>): MappedPull | null {
  if (typeof pull.number !== 'number') return null

  return {
    number: pull.number,
    title: String(pull.title ?? '').slice(0, 500),
    body: String(pull.body ?? ''),
    state: pullState(pull),
    draft: Boolean(pull.draft),
    headRef: pull.head?.ref ?? null,
    baseRef: pull.base?.ref ?? null,
    attribution: attribute(pull.user, linked),
    createdAt: pull.created_at ?? null,
    mergedAt: pull.merged_at ?? null,
  }
}

export interface MappedReviewComment {
  externalId: number
  path: string
  line: number | null
  side: 'left' | 'right'
  body: string
  attribution: Attribution
  createdAt: string | null
  /** Set when this is a reply, so a thread can be rebuilt in order. */
  inReplyTo: number | null
}

export function mapReviewComment(
  comment: GitHubReviewComment,
  linked: ReadonlyMap<string, number>,
): MappedReviewComment | null {
  if (typeof comment.id !== 'number' || !comment.path) return null

  return {
    externalId: comment.id,
    path: comment.path,
    line: commentLine(comment),
    side: commentSide(comment),
    body: String(comment.body ?? ''),
    attribution: attribute(comment.user, linked),
    createdAt: comment.created_at ?? null,
    inReplyTo: typeof comment.in_reply_to_id === 'number' ? comment.in_reply_to_id : null,
  }
}

/**
 * Group review comments into threads.
 *
 * GitHub models a thread as a root comment plus replies pointing at it, so the
 * shape has to be rebuilt rather than read. A reply whose root was not imported
 * becomes its own thread instead of being dropped: an orphaned comment is still
 * something someone wrote.
 */
export function buildThreads(comments: readonly MappedReviewComment[]): MappedReviewComment[][] {
  const byId = new Map(comments.map(c => [c.externalId, c]))
  const threads = new Map<number, MappedReviewComment[]>()

  for (const comment of comments) {
    const rootId = comment.inReplyTo !== null && byId.has(comment.inReplyTo)
      ? comment.inReplyTo
      : comment.externalId

    const thread = threads.get(rootId) ?? []
    thread.push(comment)
    threads.set(rootId, thread)
  }

  // Oldest first within a thread, so a conversation reads in the order it
  // happened rather than the order the API returned it.
  return [...threads.values()].map(thread =>
    [...thread].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))),
  )
}
