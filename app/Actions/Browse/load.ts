/**
 * Reading a repository's contents at a ref.
 *
 * Thin wrappers over git plumbing, kept apart from the actions so the browse
 * view and the JSON API read a repository the same way. Everything that shapes
 * the result for display lives in `resources/functions/browse`; this only
 * fetches.
 */

import { parseTreeEntries, type TreeEntry } from '../../../resources/functions/browse'
import { isSafeRevision, runGit } from '../Git/git'

/** How large a file may be before the browser declines to render it. */
export const MAX_BLOB_BYTES = 512 * 1024

export interface TreeListing {
  ok: boolean
  entries: TreeEntry[]
  /** Set when the ref or path does not resolve, for the view to show. */
  error: string | null
}

/**
 * List a directory at a ref.
 *
 * A path that does not exist is not an exception: browsing to a stale link is
 * ordinary, and the view wants to say so rather than return a 500.
 */
export async function listTree(repositoryPath: string, ref: string, path = ''): Promise<TreeListing> {
  if (!isSafeRevision(ref))
    return { ok: false, entries: [], error: 'Invalid ref' }

  // `-z` because a filename may contain a newline, `--long` for sizes.
  const target = path ? `${ref}:${path}` : ref
  const result = await runGit(repositoryPath, ['ls-tree', '-z', '--long', target])

  if (!result.ok)
    return { ok: false, entries: [], error: 'No such path at that ref' }

  return { ok: true, entries: parseTreeEntries(result.stdout), error: null }
}

export interface BlobContent {
  ok: boolean
  text: string | null
  size: number
  /** True when the file is binary or too large, so the view offers a download instead. */
  tooLarge: boolean
  binary: boolean
  error: string | null
}

/**
 * Read a file at a ref.
 *
 * Refuses binary and oversized content rather than streaming megabytes of it
 * into a page: a browser that hangs on a vendored bundle is worse than one that
 * says the file is too large to show.
 */
export async function readBlob(repositoryPath: string, ref: string, path: string): Promise<BlobContent> {
  if (!isSafeRevision(ref))
    return { ok: false, text: null, size: 0, tooLarge: false, binary: false, error: 'Invalid ref' }

  const sizeResult = await runGit(repositoryPath, ['cat-file', '-s', `${ref}:${path}`])
  if (!sizeResult.ok)
    return { ok: false, text: null, size: 0, tooLarge: false, binary: false, error: 'No such file at that ref' }

  const size = Number(sizeResult.stdout.trim())
  if (size > MAX_BLOB_BYTES)
    return { ok: true, text: null, size, tooLarge: true, binary: false, error: null }

  const result = await runGit(repositoryPath, ['cat-file', 'blob', `${ref}:${path}`])
  if (!result.ok)
    return { ok: false, text: null, size, tooLarge: false, binary: false, error: 'Could not read file' }

  // A NUL byte is git's own heuristic for binary, and it is good enough: text
  // files do not contain one.
  if (result.stdout.includes('\0'))
    return { ok: true, text: null, size, tooLarge: false, binary: true, error: null }

  return { ok: true, text: result.stdout, size, tooLarge: false, binary: false, error: null }
}

export interface CommitSummary {
  sha: string
  subject: string
  authorName: string
  when: string
}

/**
 * The most recent commit touching a path, for the "last changed" line.
 *
 * Returns null rather than throwing on an empty repository, which is a state a
 * freshly created repository is legitimately in.
 */
export async function lastCommit(repositoryPath: string, ref: string, path = ''): Promise<CommitSummary | null> {
  if (!isSafeRevision(ref)) return null

  const args = ['log', '-1', '--format=%H%x00%s%x00%an%x00%aI', ref]
  if (path) args.push('--', path)

  const result = await runGit(repositoryPath, args)
  if (!result.ok || !result.stdout.trim()) return null

  const [sha, subject, authorName, when] = result.stdout.trim().split('\0')
  if (!sha) return null

  return { sha, subject: subject ?? '', authorName: authorName ?? '', when: when ?? '' }
}

/** Branch names, for the ref picker. */
export async function branchNames(repositoryPath: string): Promise<string[]> {
  const result = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!result.ok) return []
  return result.stdout.split('\n').map(l => l.trim()).filter(Boolean)
}
