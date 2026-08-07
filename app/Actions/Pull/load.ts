/**
 * Reading a pull request's diff out of the repository on disk.
 *
 * The one decision that matters here is *what* is diffed. `git diff base head`
 * compares the tips, which means every change somebody else landed on the base
 * while this branch was open appears in the review, and the reviewer is asked
 * to approve work that is not part of this change. The merge base is where the
 * two histories parted, and the diff from there is exactly the author's work.
 *
 * This is the wrapper the view calls; the parsing it feeds is pure and tested
 * separately in `diff.ts`.
 */

import { mergeBase, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'

export interface DiffOptions {
  /** Lines of context either side. Three is what `git diff` uses. */
  context?: number
  /** Skip whitespace-only changes at the git level, which is cheaper than hiding them later. */
  ignoreWhitespace?: boolean
  /**
   * Restrict the diff to these paths. Single-file review mode's whole
   * mechanism: git does the restricting, so one file's page never pays for
   * the other hundred.
   */
  paths?: string[]
}

/**
 * The unified diff for a pull request, as text.
 *
 * Returns an empty string when the repository or either commit is missing,
 * which the caller renders as "no changes" rather than an error page: a pull
 * request whose branch was deleted should still show its conversation.
 */
export async function pullRequestDiff(
  owner: string,
  repositoryName: string,
  baseSha: string,
  headSha: string,
  options: DiffOptions = {},
): Promise<string> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return ''

  const base = await mergeBase(resolved.path!, baseSha, headSha)
  if (!base)
    return ''

  const args = [
    'diff',
    `--unified=${options.context ?? 3}`,
    // Renames and copies are detected here rather than inferred later: git has
    // the blob hashes and we do not.
    '--find-renames',
    '--find-copies',
    '--no-color',
    // A repository's own config must not change how a diff is read; a
    // `diff.external` in a pushed config would otherwise run somebody's binary.
    '--no-ext-diff',
  ]

  if (options.ignoreWhitespace)
    args.push('--ignore-all-space')

  args.push(base, headSha)

  // Everything after `--` is a path, never a revision - which is also what
  // keeps a file named like a branch from being read as one.
  if (options.paths && options.paths.length > 0)
    args.push('--', ...options.paths)

  const result = await runGit(resolved.path!, args, { timeoutMs: 60_000 })

  return result.ok ? result.stdout : ''
}

/**
 * The paths a pull request changes, in diff order.
 *
 * The cheap list single-file navigation is built from: `--name-only` costs a
 * tree walk, not a content diff, so asking for it on every single-file page
 * is nothing next to rendering one file.
 */
export async function changedPathsFor(
  owner: string,
  repositoryName: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return []

  const base = await mergeBase(resolved.path!, baseSha, headSha)
  if (!base)
    return []

  const result = await runGit(resolved.path!, ['diff', '--name-only', '--no-color', base, headSha])

  return result.ok ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
}

/**
 * One commit's own diff, against its first parent.
 *
 * Commit-by-commit review's loader. `--first-parent` so a merge commit shows
 * what the merge introduced rather than replaying one side; the caller is
 * responsible for only asking about commits that are on the branch, because
 * this function will answer for any commit the repository holds.
 */
export async function commitDiff(
  owner: string,
  repositoryName: string,
  sha: string,
  options: DiffOptions = {},
): Promise<string> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok || !/^[0-9a-f]{40}$/.test(sha))
    return ''

  const result = await runGit(resolved.path!, [
    'diff',
    `--unified=${options.context ?? 3}`,
    '--find-renames',
    '--find-copies',
    '--no-color',
    '--no-ext-diff',
    `${sha}^!`,
  ], { timeoutMs: 60_000 })

  return result.ok ? result.stdout : ''
}

/** Commit subjects on the branch, oldest first. */
export async function commitsOnBranch(
  owner: string,
  repositoryName: string,
  baseSha: string,
  headSha: string,
): Promise<Array<{ sha: string, subject: string, author: string }>> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return []

  const base = await mergeBase(resolved.path!, baseSha, headSha)
  if (!base)
    return []

  // A record separator that cannot appear in a commit subject, so a subject
  // containing a tab or a pipe does not split into the wrong fields.
  const result = await runGit(resolved.path!, [
    'log',
    '--reverse',
    '--format=%H%x1f%s%x1f%an',
    `${base}..${headSha}`,
  ])

  if (!result.ok)
    return []

  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author] = line.split('\x1f')

      return { sha: sha ?? '', subject: subject ?? '', author: author ?? '' }
    })
}
