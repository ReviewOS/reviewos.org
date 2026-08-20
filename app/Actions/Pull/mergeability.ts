/**
 * Whether a pull request merges cleanly, and what conflicts if it does not.
 *
 * `git merge-tree --write-tree` answers this without a work tree and without
 * touching a single ref: it merges two commits in memory, writes the resulting
 * tree into the object database, and reports what conflicted. That matters here
 * because every repository is bare, and because computing mergeability must
 * never be able to move a branch by accident.
 *
 * The answer is a fact about two commits, so it is cached against them rather
 * than recomputed per page load. A hundred people opening a pull request should
 * cost one merge, not a hundred.
 *
 * Naming the conflicting files rather than returning a boolean is the point.
 * "This branch has conflicts" sends somebody to their terminal to find out
 * which; the files are already in the output, so withholding them is a choice.
 */

import { isFullSha, isSafeRevision, runGit } from '../Git/git'

export type MergeState = 'clean' | 'conflicted' | 'unrelated' | 'unknown'

export interface Mergeability {
  state: MergeState
  /** The merged tree, when it is clean. Not used yet; the merge recomputes it. */
  treeSha: string | null
  /** Paths that conflicted, in the order git reported them. */
  conflictingPaths: string[]
}

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 *
 * Clean: one line, the tree oid, exit 0. Conflicted: the tree oid, then the
 * conflicting paths one per line, then a blank line, then human-readable
 * messages ("Auto-merging …", "CONFLICT (content): …"). Exit 1.
 *
 * Pure, so the awkward shapes (a path with a space, an empty output, a
 * different exit code) are testable without building a repository that
 * produces each one.
 */
export function parseMergeTree(stdout: string, exitCode: number): Mergeability {
  const lines = stdout.split('\n')
  const treeSha = (lines[0] ?? '').trim()

  if (exitCode === 0) {
    return {
      state: isFullSha(treeSha) ? 'clean' : 'unknown',
      treeSha: isFullSha(treeSha) ? treeSha : null,
      conflictingPaths: [],
    }
  }

  // Anything other than 0 or 1 is git failing rather than reporting, and a
  // failure must not read as "clean" or as "conflicted": both would be a claim
  // about the branches that nothing checked.
  if (exitCode !== 1)
    return { state: 'unknown', treeSha: null, conflictingPaths: [] }

  // Exit 1 also covers git refusing outright, which looks like
  // "merge-tree: <sha> - not something we can merge" with no tree written. A
  // real conflict report always begins with the tree it produced, so that is
  // the discriminator; without it, a deleted branch reads as a conflict in a
  // file named after the error message.
  if (!isFullSha(treeSha))
    return { state: 'unknown', treeSha: null, conflictingPaths: [] }

  const conflictingPaths: string[] = []

  for (const line of lines.slice(1)) {
    // The blank line ends the file list and starts the messages. Without this
    // "Auto-merging src/cart.ts" would be reported as a conflicting file.
    if (line.trim() === '')
      break

    conflictingPaths.push(line)
  }

  return { state: 'conflicted', treeSha, conflictingPaths }
}

/**
 * Ask git whether these two commits merge.
 *
 * Returns `unknown` rather than throwing when the repository or either commit
 * is missing. A pull request whose branch was deleted should still render, and
 * an unknown answer blocks the merge anyway.
 */
export async function checkMergeability(
  repositoryPath: string,
  baseSha: string,
  headSha: string,
): Promise<Mergeability> {
  if (!isSafeRevision(baseSha) || !isSafeRevision(headSha))
    return { state: 'unknown', treeSha: null, conflictingPaths: [] }

  const result = await runGit(
    repositoryPath,
    ['merge-tree', '--write-tree', '--name-only', baseSha, headSha],
    { timeoutMs: 60_000 },
  )

  // Unrelated histories are reported on stderr with a distinct exit code, and
  // are worth separating: they are not a conflict somebody can resolve by
  // rebasing, they mean the branches share no history at all.
  if (result.stderr.includes('unrelated histories'))
    return { state: 'unrelated', treeSha: null, conflictingPaths: [] }

  return parseMergeTree(result.stdout, result.code)
}

/**
 * The `mergeable_state` column value for a computed answer.
 *
 * The column's vocabulary predates this and carries `dirty` for a conflict,
 * which is git's own word for it, so the mapping is here rather than spread
 * across the callers.
 */
export function toMergeableState(mergeability: Mergeability): 'unknown' | 'clean' | 'dirty' {
  switch (mergeability.state) {
    case 'clean':
      return 'clean'
    case 'conflicted':
    case 'unrelated':
      return 'dirty'
    default:
      return 'unknown'
  }
}

/**
 * Whether a stored answer still applies.
 *
 * Cached against the two commits it was computed from, so it is stale the
 * moment either side moves. Comparing the shas is what makes "invalidated on
 * push" fall out for free rather than needing a hook to remember.
 */
export function isCurrent(
  cached: { baseSha: string | null, headSha: string | null },
  current: { baseSha: string, headSha: string },
): boolean {
  return cached.baseSha === current.baseSha && cached.headSha === current.headSha
}

/**
 * Whether the base branch has moved on since the head last took it.
 *
 * The question behind `required_status_checks.strict` - what GitHub calls a
 * branch being out of date. False means the tip of the base is already an
 * ancestor of the head, so every check that ran on the head ran on code that
 * contained it.
 *
 * **Null when git could not answer**, which is why this is not `isAncestor`
 * from the mirror code: that one reads a failure as "history was rewritten",
 * which is the safe reading for a force push and the wrong one here. A missing
 * object would silently become "out of date", and the pull request would sit
 * there telling somebody to rebase a branch that is already current, forever.
 *
 * The caller treats null as a blocker with its own sentence, in the same way an
 * unchecked mergeability is - stated as unknown rather than guessed either way.
 *
 * `base` is a revision, so callers pass `refs/heads/main` rather than the sha
 * the pull request was opened against. Those are different commits the moment
 * anything else lands, and the stored one would answer that every branch is
 * up to date with a base that has since moved four times - which is the exact
 * situation the rule exists to catch.
 */
export async function isBehindBase(
  repositoryPath: string,
  base: string,
  headSha: string,
): Promise<boolean | null> {
  if (!isSafeRevision(base) || !isSafeRevision(headSha))
    return null

  const result = await runGit(repositoryPath, ['merge-base', '--is-ancestor', base, headSha])

  if (result.code === 0)
    return false

  // git answers 1 for "no". Anything else - a missing object, a repository that
  // is not there, a process that could not start - is not an answer.
  return result.code === 1 ? true : null
}
