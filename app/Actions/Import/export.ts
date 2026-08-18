/**
 * Everything a repository is, in a shape somebody else can read.
 *
 * A forge that is hard to leave is a forge people are right to distrust, and
 * the way that distrust is earned is not by refusing to export - it is by
 * exporting something technically complete and practically useless. A dump of
 * internal table rows with integer foreign keys into other tables is an export
 * nobody can do anything with.
 *
 * So the format is written for a reader who has never seen this codebase:
 *
 * - **Nothing is referenced by a local id.** A comment names the issue by
 *   `number`, not by `issue_id`, because a number is what the repository's own
 *   history refers to and an id is a fact about our database that means nothing
 *   anywhere else.
 * - **People are handles**, not user ids, and an imported author who was never
 *   mapped keeps the name they had wherever they came from.
 * - **The git data is a real repository**, not a blob of objects. `git clone`
 *   against the exported directory works, which means the most important half
 *   of the export needs no tooling at all to read.
 *
 * The manifest carries a `format` version. A format nobody can date is a format
 * nobody can write a reader for two years from now.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Imported rather than relied on as a global: this runs from a buddy command as
// well as from the server, and a command does not go through the preloader that
// injects the auto-imports.
import { db } from '@stacksjs/database'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'

/** The version this writer produces. Bumped when a reader would need to know. */
export const EXPORT_FORMAT = 1

export interface ExportManifest {
  format: number
  exported_at: string
  repository: {
    owner: string
    name: string
    description: string | null
    visibility: string
    default_branch: string
  }
  /** Where the git data is, relative to the manifest. */
  git: string
  counts: Record<string, number>
}

export interface ExportedIssue {
  number: number
  title: string
  body: string
  state: string
  /** The local handle, or the name they had wherever this was imported from. */
  author: string | null
  labels: string[]
  milestone: string | null
  created_at: string | null
  closed_at: string | null
  comments: ExportedComment[]
}

export interface ExportedComment {
  author: string | null
  body: string
  created_at: string | null
}

export interface ExportedPullRequest {
  number: number
  title: string
  body: string
  state: string
  author: string | null
  head_branch: string
  base_branch: string
  head_sha: string
  base_sha: string
  draft: boolean
  created_at: string | null
  merged_at: string | null
  comments: ExportedComment[]
  review_threads: ExportedThread[]
}

export interface ExportedThread {
  /** The anchor, which is what makes an exported review still a review. */
  path: string
  line: number | null
  side: string
  resolved: boolean
  comments: ExportedComment[]
}

/**
 * Who to name as the author of a row.
 *
 * A handle when there is a local account, the recorded external name when the
 * row came from an import and was never mapped, and `null` when there is
 * neither - which is honest rather than convenient. An export that filled the
 * gap with "unknown" would be inventing a person.
 */
export function authorName(row: { handle?: unknown, external_author?: unknown }): string | null {
  const handle = String(row.handle ?? '').trim()

  if (handle)
    return handle

  const external = String(row.external_author ?? '').trim()

  return external || null
}

/**
 * A manifest for a repository and what came out of it.
 *
 * Separate from the writing so the shape can be asserted without a filesystem,
 * and so the counts are computed from what was actually exported rather than
 * from a query that might disagree with it.
 */
export function manifest(input: {
  owner: string
  name: string
  description: string | null
  visibility: string
  defaultBranch: string
  counts: Record<string, number>
  now: Date
}): ExportManifest {
  return {
    format: EXPORT_FORMAT,
    exported_at: input.now.toISOString(),
    repository: {
      owner: input.owner,
      name: input.name,
      description: input.description,
      visibility: input.visibility,
      default_branch: input.defaultBranch,
    },
    // A relative path, so the archive can be unpacked anywhere and the manifest
    // still points at the repository beside it.
    git: 'git',
    counts: input.counts,
  }
}

/**
 * Write the export, and report what went into it.
 *
 * Here rather than in the command so a test can run the real thing. An export
 * whose only caller is a CLI entry point is an export nothing exercises, and
 * this is the feature whose entire purpose is being trustworthy.
 */
export async function writeExport(ownerHandle: string, name: string, destination: string): Promise<ExportManifest> {
  const repository = await findRepository(ownerHandle.toLowerCase(), name)

  if (!repository)
    throw new Error(`There is no repository called ${ownerHandle}/${name} here`)

  await mkdir(destination, { recursive: true })

  /*
   * The git data first, as a real repository.
   *
   * `git clone --bare` of our own bare repository, which produces something a
   * person can clone from directly - rather than copying the directory, which
   * would carry our hooks, our config and whatever else this instance keeps in
   * there.
   */
  const resolved = repositoryPath(ownerHandle.toLowerCase(), name)

  if (!resolved.ok)
    throw new Error('the repository path did not resolve')

  const gitDestination = join(destination, 'git')
  const clone = await runGit(destination, ['clone', '--bare', resolved.path!, gitDestination])

  if (!clone.ok)
    throw new Error(`could not copy the git data: ${clone.stderr.slice(0, 300)}`)

  await runGit(gitDestination, ['remote', 'remove', 'origin'])

  const issues = await exportIssues(Number(repository.id))
  const pulls = await exportPullRequests(Number(repository.id))

  await writeFile(join(destination, 'issues.json'), `${JSON.stringify(issues, null, 2)}\n`)
  await writeFile(join(destination, 'pull-requests.json'), `${JSON.stringify(pulls, null, 2)}\n`)

  const counts = {
    issues: issues.length,
    pull_requests: pulls.length,
    comments: issues.reduce((sum, one) => sum + one.comments.length, 0)
      + pulls.reduce((sum, one) => sum + one.comments.length, 0),
    review_threads: pulls.reduce((sum, one) => sum + one.review_threads.length, 0),
  }

  const written = manifest({
    owner: ownerHandle,
    name,
    description: repository.description ? String(repository.description) : null,
    visibility: String(repository.visibility),
    defaultBranch: String(repository.default_branch),
    counts,
    now: new Date(),
  })

  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(written, null, 2)}\n`)

  return written
}

async function findRepository(ownerHandle: string, name: string): Promise<any | null> {
  for (const [table, type] of [['users', 'user'], ['organizations', 'organization']] as const) {
    const owner = await db.selectFrom(table).select(['id']).where('handle', '=', ownerHandle).executeTakeFirst()

    if (!owner)
      continue

    const repository = await db
      .selectFrom('repositories')
      .selectAll()
      .where('owner_type', '=', type)
      .where('owner_id', '=', Number(owner.id))
      .where('name', '=', name)
      .executeTakeFirst()

    if (repository)
      return repository
  }

  return null
}

/** Every issue, with its comments, keyed by the number people refer to. */
async function exportIssues(repositoryId: number): Promise<ExportedIssue[]> {
  const rows = await db
    .selectFrom('issues')
    .leftJoin('users', 'users.id', '=', 'issues.author_id')
    .select([
      'issues.id as id',
      'issues.number as number',
      'issues.title as title',
      'issues.body as body',
      'issues.state as state',
      'issues.created_at as created_at',
      'issues.closed_at as closed_at',
      'issues.external_author as external_author',
      'users.handle as handle',
    ])
    .where('issues.repository_id', '=', repositoryId)
    .orderBy('issues.number', 'asc')
    .execute()

  const exported: ExportedIssue[] = []

  for (const row of rows) {
    exported.push({
      number: Number(row.number),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      state: String(row.state ?? 'open'),
      author: authorName(row),
      labels: await labelsFor(Number(row.id)),
      milestone: null,
      created_at: row.created_at ? String(row.created_at) : null,
      closed_at: row.closed_at ? String(row.closed_at) : null,
      comments: await commentsOn('issue', Number(row.id)),
    })
  }

  return exported
}

async function exportPullRequests(repositoryId: number): Promise<ExportedPullRequest[]> {
  const rows = await db
    .selectFrom('pull_requests')
    .leftJoin('users', 'users.id', '=', 'pull_requests.author_id')
    .select([
      'pull_requests.id as id',
      'pull_requests.number as number',
      'pull_requests.title as title',
      'pull_requests.body as body',
      'pull_requests.state as state',
      'pull_requests.head_branch as head_branch',
      'pull_requests.base_branch as base_branch',
      'pull_requests.head_sha as head_sha',
      'pull_requests.base_sha as base_sha',
      'pull_requests.draft as draft',
      'pull_requests.created_at as created_at',
      'pull_requests.merged_at as merged_at',
      'pull_requests.external_author as external_author',
      'users.handle as handle',
    ])
    .where('pull_requests.repository_id', '=', repositoryId)
    .orderBy('pull_requests.number', 'asc')
    .execute()

  const exported: ExportedPullRequest[] = []

  for (const row of rows) {
    exported.push({
      number: Number(row.number),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      state: String(row.state ?? 'open'),
      author: authorName(row),
      head_branch: String(row.head_branch ?? ''),
      base_branch: String(row.base_branch ?? ''),
      head_sha: String(row.head_sha ?? ''),
      base_sha: String(row.base_sha ?? ''),
      draft: Boolean(row.draft),
      created_at: row.created_at ? String(row.created_at) : null,
      merged_at: row.merged_at ? String(row.merged_at) : null,
      comments: await commentsOn('pull_request', Number(row.id)),
      review_threads: await threadsOn(Number(row.id)),
    })
  }

  return exported
}

/** The label names, because a colour is ours and a name is theirs. */
async function labelsFor(issueId: number): Promise<string[]> {
  try {
    const rows = await db
      .selectFrom('issue_labels')
      .innerJoin('repository_labels', 'repository_labels.id', '=', 'issue_labels.label_id')
      .select(['repository_labels.name as name'])
      .where('issue_labels.issue_id', '=', issueId)
      .execute()

    return rows.map(row => String(row.name))
  }
  catch {
    return []
  }
}

async function commentsOn(type: string, id: number): Promise<ExportedComment[]> {
  try {
    const rows = await db
      .selectFrom('issue_comments')
      .leftJoin('users', 'users.id', '=', 'issue_comments.author_id')
      .select([
        'issue_comments.body as body',
        'issue_comments.created_at as created_at',
        'issue_comments.external_author as external_author',
        'users.handle as handle',
      ])
      .where('issue_comments.commentable_type', '=', type)
      .where('issue_comments.commentable_id', '=', id)
      .orderBy('issue_comments.id', 'asc')
      .execute()

    return rows.map(row => ({
      author: authorName(row),
      body: String(row.body ?? ''),
      created_at: row.created_at ? String(row.created_at) : null,
    }))
  }
  catch {
    return []
  }
}

/**
 * Review threads, with the anchor.
 *
 * The file, the line and the side, because without them an exported review is a
 * list of remarks about nothing - which is exactly the failure the importer is
 * written to avoid, and it would be perverse to reintroduce it on the way out.
 */
async function threadsOn(pullRequestId: number): Promise<ExportedThread[]> {
  try {
    const rows = await db
      .selectFrom('review_threads')
      .selectAll()
      .where('pull_request_id', '=', pullRequestId)
      .orderBy('id', 'asc')
      .execute()

    const threads: ExportedThread[] = []

    for (const row of rows) {
      const comments = await db
        .selectFrom('review_comments')
        .leftJoin('users', 'users.id', '=', 'review_comments.author_id')
        .select([
          'review_comments.body as body',
          'review_comments.created_at as created_at',
          'review_comments.external_author as external_author',
          'users.handle as handle',
        ])
        .where('review_comments.review_thread_id', '=', Number(row.id))
        .orderBy('review_comments.id', 'asc')
        .execute()

      threads.push({
        path: String(row.path ?? ''),
        line: row.line === null || row.line === undefined ? null : Number(row.line),
        side: String(row.side ?? 'right'),
        // `resolved`, not `resolved_at`: there is no such column, so every
        // exported thread claimed to be unresolved whatever it was.
        resolved: Boolean(row.resolved),
        comments: comments.map(comment => ({
          author: authorName(comment),
          body: String(comment.body ?? ''),
          created_at: comment.created_at ? String(comment.created_at) : null,
        })),
      })
    }

    return threads
  }
  catch {
    return []
  }
}
