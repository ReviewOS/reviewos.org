/**
 * Writing a commit into a bare repository, without a worktree.
 *
 * Bare repositories are the only kind here, so there is nowhere to check files
 * out to. Everything goes through plumbing against a temporary index:
 *
 *   hash-object    content becomes a blob
 *   read-tree      the parent commit's tree becomes the starting index
 *   update-index   the changed paths are staged over it
 *   write-tree     the index becomes a tree
 *   commit-tree    the tree plus its parents becomes a commit
 *   update-ref     the branch moves, guarded by its expected old value
 *
 * The temporary index is what makes nested paths work. `mktree` builds one
 * directory at a time, so `docs/guide/index.md` would mean assembling three
 * trees by hand and getting the order right; an index does that itself.
 *
 * `update-ref` is guarded by the old value everywhere, so two writers racing
 * cannot lose one another's commit: the loser is told the ref moved rather than
 * quietly overwriting it. That is the same rule `apply.ts` follows for merges.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFullSha, isSafeRef, runGit } from './git'

export interface CommitAuthor {
  name: string
  email: string
  /** ISO 8601. Passed in rather than read from the clock so callers stay testable. */
  date?: string
}

export interface CommitInput {
  branch: string
  /** The commit this one descends from. Null for the first commit in a repository. */
  parentSha: string | null
  /**
   * What the branch is expected to point at right now, as the `update-ref`
   * guard. Null means it must not exist yet.
   *
   * Deliberately separate from `parentSha`, which is a different question:
   * branching `feature` off `main` has a parent but no existing ref, and using
   * the parent as the guard there asks git to compare-and-swap a ref that is
   * not there. Omit it and the branch's current value is read and used, which
   * is right for an ordinary append; pass it when the caller read the tip
   * earlier and wants to be told if it moved in between.
   */
  expectedBranchSha?: string | null
  message: string
  author: CommitAuthor
  /** Path to content. A null value deletes the path. */
  files: Record<string, string | null>
}

export type CommitOutcome =
  | { ok: true, sha: string }
  | { ok: false, error: string }

/** Write a commit and move the branch to it. */
export async function createCommit(repositoryPath: string, input: CommitInput): Promise<CommitOutcome> {
  if (!isSafeRef(input.branch))
    return { ok: false, error: 'That branch name cannot be used' }

  if (input.parentSha !== null && !isFullSha(input.parentSha))
    return { ok: false, error: 'A parent has to be a full commit sha' }

  for (const path of Object.keys(input.files)) {
    if (!isSafePath(path))
      return { ok: false, error: `That path cannot be used: ${path}` }
  }

  // Its own directory rather than its own file, so a stale lock file git leaves
  // beside the index is cleaned up with it.
  const indexDirectory = await mkdtemp(join(tmpdir(), 'reviewos-index-'))
  const env = { GIT_INDEX_FILE: join(indexDirectory, 'index') }

  try {
    if (input.parentSha) {
      const read = await runGit(repositoryPath, ['read-tree', input.parentSha], { env })
      if (!read.ok)
        return { ok: false, error: `Could not read the parent commit: ${read.stderr.trim()}` }
    }

    // Staged through `--index-info` rather than `--cacheinfo` and
    // `--force-remove`. Removal via `--force-remove` insists on a work tree,
    // which a bare repository does not have; `--index-info` handles additions
    // and removals alike (mode 0 removes) and takes them all in one process
    // rather than one per file.
    const entries: string[] = []

    for (const [path, content] of Object.entries(input.files)) {
      if (content === null) {
        entries.push(`0 ${'0'.repeat(40)}\t${path}`)
        continue
      }

      const blob = await runGit(repositoryPath, ['hash-object', '-w', '--stdin'], { input: content, env })
      if (!blob.ok)
        return { ok: false, error: `Could not write ${path}: ${blob.stderr.trim()}` }

      const sha = blob.stdout.trim()
      if (!isFullSha(sha))
        return { ok: false, error: `git returned something that is not a blob for ${path}` }

      entries.push(`100644 ${sha}\t${path}`)
    }

    if (entries.length > 0) {
      const staged = await runGit(
        repositoryPath,
        ['update-index', '--add', '--remove', '--index-info'],
        { input: `${entries.join('\n')}\n`, env },
      )

      if (!staged.ok)
        return { ok: false, error: `Could not stage the changes: ${staged.stderr.trim()}` }
    }

    const tree = await runGit(repositoryPath, ['write-tree'], { env })
    if (!tree.ok)
      return { ok: false, error: `Could not write the tree: ${tree.stderr.trim()}` }

    const treeSha = tree.stdout.trim()
    if (!isFullSha(treeSha))
      return { ok: false, error: 'git returned something that is not a tree' }

    const authorEnv = authorEnvironment(input.author)
    const parents = input.parentSha ? ['-p', input.parentSha] : []

    const commit = await runGit(
      repositoryPath,
      ['commit-tree', treeSha, ...parents, '-m', input.message],
      { env: { ...env, ...authorEnv } },
    )

    if (!commit.ok)
      return { ok: false, error: `Could not write the commit: ${commit.stderr.trim()}` }

    const sha = commit.stdout.trim()
    if (!isFullSha(sha))
      return { ok: false, error: 'git returned something that is not a commit' }

    // An empty old value means "this ref must not exist yet", so a branch being
    // created and a branch being appended to are both compare-and-swap and
    // neither can silently overwrite a concurrent write.
    const expected = input.expectedBranchSha === undefined
      ? await branchSha(repositoryPath, input.branch)
      : input.expectedBranchSha

    const update = await runGit(
      repositoryPath,
      ['update-ref', `refs/heads/${input.branch}`, sha, expected ?? ''],
      { env: authorEnv },
    )

    if (!update.ok)
      return { ok: false, error: `Could not move the branch: ${update.stderr.trim()}` }

    return { ok: true, sha }
  }
  finally {
    await rm(indexDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/** What a branch points at, or null when it does not exist. */
export async function branchSha(repositoryPath: string, branch: string): Promise<string | null> {
  if (!isSafeRef(branch))
    return null

  const result = await runGit(repositoryPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
  const sha = result.stdout.trim()

  return result.ok && isFullSha(sha) ? sha : null
}

/**
 * Whether a path may be written.
 *
 * Absolute paths, traversal, and anything inside `.git` are refused. git itself
 * would reject most of these, but the check is here so the refusal is a clear
 * message rather than a plumbing error, and so a caller cannot reach the
 * repository's own directory through a path it assembled from user input.
 */
export function isSafePath(path: string): boolean {
  if (!path || path.length > 4096)
    return false

  if (path.startsWith('/') || path.includes('\0') || path.includes('\\'))
    return false

  const segments = path.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    return false

  return segments[0] !== '.git'
}

/**
 * The author and committer environment for a commit.
 *
 * Both are set from the same person. A seeded or applied commit has one author,
 * and leaving the committer to git's own config would stamp whoever happens to
 * be running the server onto it.
 */
export function authorEnvironment(author: CommitAuthor): Record<string, string> {
  const date = author.date ?? new Date().toISOString()

  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  }
}
