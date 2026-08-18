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

import type { DiffStreamResult } from '../Git/diffStream'
import { streamCommitDiff, streamMergeBaseDiff } from '../Git/diffStream'
import { mergeBase, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'

/**
 * How much patch text the server-rendered pull request page will hold.
 *
 * The same eight mebibytes as the streamed path's rendered-rows budget, and
 * for the same reason: past it, a diff is not something a whole-page render
 * serves anybody with, and the virtualized review screen - built for
 * arbitrary sizes - is where the reader belongs. The page says so in a banner
 * rather than silently rendering part of a change as though it were all of it.
 */
export const SSR_DIFF_BYTE_LIMIT = 8 * 1024 * 1024

export interface BoundedDiff {
  /** The patch text, whole when `truncated` is false, cut at the budget otherwise. */
  text: string
  truncated: boolean
}

/**
 * Collect a diff stream under a byte budget, cancelling git at the breach.
 *
 * The bounded infrastructure the API path already rides (`diffStream.ts`
 * applies backpressure and kills git when the reader walks away); this is the
 * whole-page consumer of it. Cancelling mid-stream marks `done.ok` false, so
 * the text gathered before the breach is kept and reported truncated rather
 * than discarded.
 */
async function collectBounded(stream: DiffStreamResult | null, maxBytes: number): Promise<BoundedDiff> {
  if (!stream)
    return { text: '', truncated: false }

  let text = ''
  let bytes = 0
  let truncated = false

  for await (const chunk of stream.chunks) {
    bytes += Buffer.byteLength(chunk, 'utf8')
    text += chunk

    if (bytes > maxBytes) {
      truncated = true
      // Breaking out of the for-await kills the child; see diffStream.ts.
      break
    }
  }

  const done = await stream.done

  if (truncated)
    return { text, truncated: true }

  return done.ok ? { text, truncated: false } : { text: '', truncated: false }
}

/**
 * How much list output the cheap loaders read: the path list and the commit
 * list. Two mebibytes is tens of thousands of entries, far past what any pull
 * request page renders, and a budget here keeps a degenerate branch from
 * buffering without bound. A cut mid-line is dropped rather than returned as
 * a path or subject that happens to be clipped.
 */
const LIST_BYTE_LIMIT = 2 * 1024 * 1024

/** The lines of a possibly-cut listing, with any partial trailing line dropped. */
function completeLines(result: { stdout: string, truncated?: boolean }): string[] {
  const lines = result.stdout.split('\n')

  if (result.truncated === true)
    lines.pop()

  return lines
}

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
  /** Override the page byte budget. Exists for tests; pages take the default. */
  maxBytes?: number
}

/**
 * The unified diff for a pull request, as text, under the page budget.
 *
 * Built on `streamMergeBaseDiff` rather than `runGit`: this used to hold the
 * entire patch as one string with no bound, which was the main way a large
 * diff killed the box - and the bounded streaming path already existed for
 * the API. The three-dot range hands the merge-base question to git, which is
 * the same answer `mergeBase` computed here by hand.
 *
 * Returns empty text when the repository or either commit is missing, which
 * the caller renders as "no changes" rather than an error page: a pull
 * request whose branch was deleted should still show its conversation.
 */
export async function pullRequestDiff(
  owner: string,
  repositoryName: string,
  baseSha: string,
  headSha: string,
  options: DiffOptions = {},
): Promise<BoundedDiff> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return { text: '', truncated: false }

  const stream = streamMergeBaseDiff(resolved.path!, baseSha, headSha, {
    context: options.context,
    paths: options.paths,
    ignoreWhitespace: options.ignoreWhitespace,
  })

  return await collectBounded(stream, options.maxBytes ?? SSR_DIFF_BYTE_LIMIT)
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

  const result = await runGit(resolved.path!, ['diff', '--name-only', '--no-color', base, headSha], { maxBytes: LIST_BYTE_LIMIT })

  return result.ok ? completeLines(result).map(line => line.trim()).filter(Boolean) : []
}

/**
 * One commit's own diff, against its first parent.
 *
 * Commit-by-commit review's loader, on the same bounded stream as the whole
 * diff. `--first-parent` (inside `streamCommitDiff`) so a merge commit shows
 * what the merge introduced rather than replaying one side; the caller is
 * responsible for only asking about commits that are on the branch, because
 * this function will answer for any commit the repository holds.
 */
export async function commitDiff(
  owner: string,
  repositoryName: string,
  sha: string,
  options: DiffOptions = {},
): Promise<BoundedDiff> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok || !/^[0-9a-f]{40}$/.test(sha))
    return { text: '', truncated: false }

  const stream = streamCommitDiff(resolved.path!, sha, {
    context: options.context,
    ignoreWhitespace: options.ignoreWhitespace,
  })

  return await collectBounded(stream, options.maxBytes ?? SSR_DIFF_BYTE_LIMIT)
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
  ], { maxBytes: LIST_BYTE_LIMIT })

  if (!result.ok)
    return []

  return completeLines(result)
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author] = line.split('\x1f')

      return { sha: sha ?? '', subject: subject ?? '', author: author ?? '' }
    })
}
