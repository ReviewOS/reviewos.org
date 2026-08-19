/**
 * GitLab, translated into the shape the rest of the import already reads.
 *
 * Gitea and Forgejo were a handful of parameters because they answer GitHub's
 * API deliberately. GitLab does not: it is a different vocabulary for the same
 * ideas, and pretending otherwise would mean a branch at every use site.
 *
 * So this is an adapter. Everything here turns a GitLab object into the object
 * the mirror's mappers and the import's stages already understand, and after
 * this file nothing knows which forge the data came from.
 *
 * The vocabulary, side by side:
 *
 * | Here | GitHub | GitLab |
 * |---|---|---|
 * | the number in `#123` | `number` | `iid` |
 * | a proposed change | pull request | merge request |
 * | a comment | comment | note |
 * | a review thread | review comment | discussion |
 * | open | `open` | `opened` |
 * | who wrote it | `user.login` | `author.username` |
 * | a repository | `owner/name` | a project, by id or encoded path |
 *
 * **`iid` rather than `id` is the one that silently destroys an import.** Every
 * GitLab object has both: `id` is unique across the whole instance and `iid` is
 * the number in the URL, the number in `#123`, and the number this import
 * preserves. Reading `id` produces issues numbered 4,318 and 4,319 in a
 * repository whose highest issue was 12 - and every cross reference in its own
 * history breaks, quietly, because the numbers are still plausible.
 */

import { dbTimestamp } from '../Support/sql'

/** GitLab says `opened`; everything else says `open`. */
export function issueState(state: unknown): 'open' | 'closed' {
  return String(state ?? '').toLowerCase() === 'closed' ? 'closed' : 'open'
}

/**
 * A merge request's state, which has three values rather than two.
 *
 * `merged` is a state in GitLab and a timestamp in GitHub, and the difference
 * matters: a merged pull request recorded as merely closed loses the fact that
 * the work landed, which is the single thing anybody looks at a closed pull
 * request to find out.
 */
export function mergeRequestState(raw: unknown): { state: string, mergedAt: string | null } {
  const record = raw as Record<string, unknown> | null
  const state = String(record?.state ?? '').toLowerCase()

  if (state === 'merged')
    return { state: 'merged', mergedAt: String(record?.merged_at ?? '') || null }

  return { state: state === 'closed' ? 'closed' : 'open', mergedAt: null }
}

/** GitLab's author, in the shape the attribution code reads. */
export function author(raw: unknown): { login: string, name?: string | null } | null {
  const record = (raw as any)?.author ?? (raw as any)?.user ?? null
  const login = String(record?.username ?? '').trim()

  return login ? { login, name: record?.name ? String(record.name) : null } : null
}

/** A GitLab issue as the import's issue mapper expects one. */
export function asIssue(raw: any): Record<string, unknown> {
  return {
    // `iid`, never `id`. See the note at the top of this file.
    number: Number(raw?.iid ?? 0),
    title: String(raw?.title ?? ''),
    body: String(raw?.description ?? ''),
    state: issueState(raw?.state),
    user: author(raw),
    labels: (raw?.labels ?? []).map((label: unknown) => ({ name: String(label) })),
    created_at: raw?.created_at ? String(raw.created_at) : null,
    closed_at: raw?.closed_at ? String(raw.closed_at) : null,
  }
}

/** A GitLab merge request as the import's pull request mapper expects one. */
export function asPullRequest(raw: any): Record<string, unknown> {
  const { state, mergedAt } = mergeRequestState(raw)

  return {
    number: Number(raw?.iid ?? 0),
    title: String(raw?.title ?? ''),
    body: String(raw?.description ?? ''),
    state,
    user: author(raw),
    draft: Boolean(raw?.draft ?? raw?.work_in_progress),
    head: { ref: String(raw?.source_branch ?? ''), sha: String(raw?.sha ?? '') },
    base: { ref: String(raw?.target_branch ?? ''), sha: String(raw?.diff_refs?.base_sha ?? '') },
    created_at: raw?.created_at ? String(raw.created_at) : null,
    merged_at: mergedAt,
    closed_at: raw?.closed_at ? String(raw.closed_at) : null,
  }
}

/**
 * A GitLab discussion note as a review comment.
 *
 * The anchor lives in `position`, and which line to read depends on which side
 * the comment is on: `new_line` for the right, `old_line` for the left. A
 * comment on a deleted line has only `old_line`, and reading `new_line` there
 * gives null - an anchorless comment, which is the exact loss this whole
 * importer exists to prevent.
 *
 * Returns null for a note with no position at all: those are ordinary comments
 * on the merge request, not review comments, and filing them as review comments
 * would put a general remark on an arbitrary line of an arbitrary file.
 */
export function asReviewComment(note: any, mergeRequestIid: number): Record<string, unknown> | null {
  const position = note?.position

  if (!position || !position.new_path && !position.old_path)
    return null

  const side = position.new_line !== null && position.new_line !== undefined ? 'RIGHT' : 'LEFT'
  const line = side === 'RIGHT' ? Number(position.new_line) : Number(position.old_line)

  return {
    id: Number(note?.id ?? 0),
    // The path on the side the comment is on. A comment on a renamed file has
    // both, and using the wrong one anchors it to a path that does not exist on
    // that side of the diff.
    path: String(side === 'RIGHT' ? position.new_path ?? position.old_path : position.old_path ?? position.new_path),
    line: Number.isFinite(line) ? line : null,
    side,
    body: String(note?.body ?? ''),
    user: author(note),
    created_at: note?.created_at ? String(note.created_at) : null,
    in_reply_to_id: null,
    pull_request_url: `/pulls/${mergeRequestIid}`,
  }
}

/**
 * A GitLab note as an issue comment.
 *
 * System notes are dropped. GitLab records "changed the milestone", "assigned
 * to somebody" and "mentioned in commit abc" as notes with `system: true`, and
 * importing them would bury every real comment in a repository under machine
 * chatter that reads, in this product, as though a person wrote it.
 */
export function asIssueComment(note: any, subjectIid: number): Record<string, unknown> | null {
  if (note?.system)
    return null

  return {
    id: Number(note?.id ?? 0),
    issue_url: `/issues/${subjectIid}`,
    body: String(note?.body ?? ''),
    user: author(note),
    created_at: note?.created_at ? String(note.created_at) : null,
  }
}

/** A GitLab release, as the releases stage reads one. */
export function asRelease(raw: any): Record<string, unknown> {
  return {
    tag_name: String(raw?.tag_name ?? ''),
    name: String(raw?.name ?? raw?.tag_name ?? ''),
    body: String(raw?.description ?? ''),
    prerelease: Boolean(raw?.upcoming_release),
    target_commitish: String(raw?.commit?.id ?? '') || null,
    published_at: raw?.released_at ? dbTimestamp(String(raw.released_at)) : null,
    author: author(raw),
    /*
     * GitLab's release assets are *links*, not uploaded files.
     *
     * A release links to a package registry, a CI artefact, or an arbitrary
     * URL - there is no file attached to the release itself. So they are
     * carried as links with their url, and the importer downloads whatever is
     * on the other end. A link to somewhere that no longer answers is recorded
     * as a problem rather than silently dropped, because "the binary is gone"
     * is a fact somebody needs during a migration.
     */
    assets: (raw?.assets?.links ?? []).map((link: any) => ({
      name: String(link?.name ?? ''),
      browser_download_url: String(link?.direct_asset_url ?? link?.url ?? ''),
      content_type: 'application/octet-stream',
    })),
  }
}

/**
 * The project path, encoded the way GitLab's API wants it.
 *
 * `acme/api` becomes `acme%2Fapi`, because the whole path is one path segment
 * in `/projects/{id}`. Sending it unencoded reaches `/projects/acme/api`, which
 * is a different endpoint and answers 404 - the same shape of failure as every
 * other one in this file: it looks like the repository does not exist.
 *
 * A subgroup path has more than one slash and every one of them is encoded,
 * which is why this is a replacement rather than a split.
 */
export function projectPath(owner: string, name: string): string {
  return encodeURIComponent(`${owner}/${name}`)
}
