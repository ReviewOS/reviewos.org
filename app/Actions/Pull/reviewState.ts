/**
 * Where a reviewer got to, kept on the server.
 *
 * Two things: which files they have finished with, and the comment they were
 * halfway through writing. Both used to live in the browser's local storage,
 * which remembers them across a reload and forgets them across a machine - and
 * a review of two hundred files is exactly the kind of thing somebody starts on
 * a laptop and finishes on a desktop.
 *
 * Everything here is scoped to one pull request and one person. Nobody can read
 * anybody else's progress, because there is nothing to read: every query is
 * bounded by the reviewer's own id.
 */

import { dbTimestamp } from '../Support/sql'

/** The longest draft we will store. A comment, not a document. */
export const DRAFT_LIMIT = 65_536

/** The longest path we will accept, matching the column's own validation. */
export const PATH_LIMIT = 1024

export interface ViewedFile {
  path: string
  /** The head the reviewer read, so the interface can call a tick stale. */
  head_sha: string | null
}

export interface DraftComment {
  path: string
  side: 'left' | 'right'
  from: number
  to: number
  text: string
}

/**
 * The pull request named by the request, within a repository already resolved.
 *
 * By `(repository_id, number)` rather than by number alone. Numbers are per
 * repository, so a bare number is somebody else's pull request as often as it
 * is this one's.
 */
export async function pullRequestFor(repositoryId: number, number: number): Promise<{ id: number, head_sha: string } | null> {
  if (!Number.isInteger(number) || number <= 0)
    return null

  const row = await db
    .selectFrom('pull_requests')
    .select(['id', 'head_sha'])
    .where('repository_id', '=', repositoryId)
    .where('number', '=', number)
    .executeTakeFirst()

  return row ? { id: Number(row.id), head_sha: String(row.head_sha ?? '') } : null
}

export async function viewedFiles(pullRequestId: number, reviewerId: number): Promise<ViewedFile[]> {
  const rows = await db
    .selectFrom('reviewed_files')
    .select(['path', 'head_sha'])
    .where('pull_request_id', '=', pullRequestId)
    .where('reviewer_id', '=', reviewerId)
    .execute()

  return (rows ?? []).map((row) => ({
    path: String(row.path),
    head_sha: row.head_sha == null ? null : String(row.head_sha),
  }))
}

/**
 * Tick or untick one file.
 *
 * An upsert rather than a read followed by a write: the alternative is three
 * statements and a race, where a reviewer with the same pull request open in
 * two tabs has one of them fail on the unique index.
 *
 * Through the query builder's own `upsert` rather than written out, which is
 * the phase 17 rule made concrete - `ON CONFLICT ... DO UPDATE` is Postgres
 * and SQLite, `ON DUPLICATE KEY UPDATE` is MySQL, and a hand-written statement
 * picks one engine forever. The builder knows which dialect it is on; this
 * file should not have to.
 *
 * The timestamps are bound rather than `CURRENT_TIMESTAMP`, the same rule the
 * rest of this codebase follows: these columns are naive timestamps written by
 * the application, and letting the database fill one writes the *server's*
 * local clock into a column every other row got from ours.
 */
export async function setFileViewed(
  pullRequestId: number,
  repositoryId: number,
  reviewerId: number,
  path: string,
  viewed: boolean,
  headSha: string | null,
): Promise<void> {
  if (!viewed) {
    await db
      .deleteFrom('reviewed_files')
      .where('pull_request_id', '=', pullRequestId)
      .where('reviewer_id', '=', reviewerId)
      .where('path', '=', path)
      .execute()

    return
  }

  const now = dbTimestamp()

  await db.upsert(
    'reviewed_files',
    [{ pull_request_id: pullRequestId, repository_id: repositoryId, reviewer_id: reviewerId, path, head_sha: headSha, created_at: now, updated_at: now }],
    ['pull_request_id', 'reviewer_id', 'path'],
    ['head_sha', 'updated_at'],
  )
}

export async function draftFor(pullRequestId: number, authorId: number): Promise<DraftComment | null> {
  const row = await db
    .selectFrom('review_drafts')
    .select(['path', 'side', 'from_line', 'to_line', 'body'])
    .where('pull_request_id', '=', pullRequestId)
    .where('author_id', '=', authorId)
    .executeTakeFirst()

  if (!row)
    return null

  return {
    path: String(row.path),
    side: row.side === 'left' ? 'left' : 'right',
    from: Number(row.from_line),
    to: Number(row.to_line),
    text: String(row.body ?? ''),
  }
}

/** Replace the reviewer's draft, or remove it when the text is gone. */
export async function saveDraft(pullRequestId: number, repositoryId: number, authorId: number, draft: DraftComment | null): Promise<void> {
  if (draft == null || draft.text.trim() === '') {
    await db
      .deleteFrom('review_drafts')
      .where('pull_request_id', '=', pullRequestId)
      .where('author_id', '=', authorId)
      .execute()

    return
  }

  // One draft per reviewer per pull request, so a second one replaces the
  // first. See the model: the viewer only ever has one open.
  const now = dbTimestamp()

  await db.upsert(
    'review_drafts',
    [{
      pull_request_id: pullRequestId,
      repository_id: repositoryId,
      author_id: authorId,
      path: draft.path,
      side: draft.side,
      from_line: draft.from,
      to_line: draft.to,
      body: draft.text,
      created_at: now,
      updated_at: now,
    }],
    ['pull_request_id', 'author_id'],
    ['path', 'side', 'from_line', 'to_line', 'body', 'updated_at'],
  )
}

/**
 * A draft out of a request, or the reason it is not one.
 *
 * Every field is checked here rather than trusted, for the same reason the
 * browser checks them on the way out of local storage: a draft stored against
 * the wrong line comes back as a comment about code it is not about.
 */
export function draftFromRequest(request: RequestInstance): { ok: true, draft: DraftComment | null } | { ok: false, error: string } {
  const text = String(request.get('body') ?? '')
  if (text.trim() === '')
    return { ok: true, draft: null }

  if (text.length > DRAFT_LIMIT)
    return { ok: false, error: 'That draft is too long to keep' }

  const path = String(request.get('path') ?? '').trim()
  if (!path || path.length > PATH_LIMIT)
    return { ok: false, error: 'A draft needs a file' }

  const side = String(request.get('side') ?? 'right')
  if (side !== 'left' && side !== 'right')
    return { ok: false, error: 'Side must be left or right' }

  const from = Number(request.get('from_line'))
  const to = Number(request.get('to_line'))

  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1)
    return { ok: false, error: 'A draft needs the lines it was written against' }

  if (from > to)
    return { ok: false, error: 'A draft must start above the line it ends on' }

  return { ok: true, draft: { path, side, from, to, text } }
}
