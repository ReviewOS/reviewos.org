/**
 * Why a context line is here, without leaving the diff.
 *
 * Blame is the most expensive question the browser can ask - git walks
 * history per line - so it is answered for one line, when a reader asks,
 * never for a file on render. The same deferral as the suggested reviewers:
 * the cost is paid at the moment of curiosity, once.
 *
 * The line is blamed at the *merge base*, because that is the commit the
 * diff's old-side numbers index: both diff paths compare three-dot, so a
 * context line's left number is a line of the merge base, not of the base
 * branch's tip.
 */

import { runGit } from '../Git/git'
import { parseBlame } from '../Browse/parse'
import type { BlameLine } from '../Browse/parse'

export async function blameLineAt(
  diskPath: string,
  ref: string,
  path: string,
  line: number,
): Promise<BlameLine | null> {
  if (!Number.isInteger(line) || line <= 0 || !path || path.startsWith('-') || path.startsWith(':'))
    return null

  const result = await runGit(diskPath, [
    'blame',
    '--porcelain',
    '-L',
    `${line},${line}`,
    ref,
    '--',
    path,
  ], { timeoutMs: 30_000 })

  if (!result.ok)
    return null

  const lines = parseBlame(result.stdout)
  return lines[0] ?? null
}

export interface BlamedPullRequest {
  number: number
  title: string
}

/**
 * The pull request that landed one commit, when the records can say.
 *
 * Two honest steps and a stated limit. A squash or rebase tip matches a
 * merged pull request's own columns directly. A commit that rode in behind a
 * merge commit is found by walking the ancestry path to the first merge that
 * carried it and matching that. A rebase-merged middle commit matches
 * nothing, and the answer is the commit alone - which is true, and better
 * than a guess.
 */
export async function pullRequestForCommit(
  repositoryId: number,
  diskPath: string,
  sha: string,
  baseBranch: string,
): Promise<BlamedPullRequest | null> {
  // Two plain queries, not one with a composed predicate: `where(eb => ...)`
  // is the documented builder defect, and this file is not where it recurs.
  const byMerge = await db
    .selectFrom('pull_requests')
    .select(['number', 'title'])
    .where('repository_id', '=', repositoryId)
    .where('state', '=', 'merged')
    .where('merge_commit_sha', '=', sha)
    .executeTakeFirst()
    .catch(() => null)

  if (byMerge)
    return { number: Number(byMerge.number), title: String(byMerge.title) }

  const byHead = await db
    .selectFrom('pull_requests')
    .select(['number', 'title'])
    .where('repository_id', '=', repositoryId)
    .where('state', '=', 'merged')
    .where('head_sha', '=', sha)
    .executeTakeFirst()
    .catch(() => null)

  if (byHead)
    return { number: Number(byHead.number), title: String(byHead.title) }

  // The first merge commit on the path from the commit to the base branch is
  // the merge that first carried it.
  const walked = await runGit(diskPath, [
    'rev-list',
    '--ancestry-path',
    '--merges',
    '--reverse',
    `${sha}..refs/heads/${baseBranch}`,
  ], { timeoutMs: 30_000 })

  const mergeSha = walked.ok ? walked.stdout.split('\n')[0]?.trim() : ''
  if (!mergeSha)
    return null

  const carried = await db
    .selectFrom('pull_requests')
    .select(['number', 'title'])
    .where('repository_id', '=', repositoryId)
    .where('state', '=', 'merged')
    .where('merge_commit_sha', '=', mergeSha)
    .executeTakeFirst()
    .catch(() => null)

  return carried ? { number: Number(carried.number), title: String(carried.title) } : null
}
