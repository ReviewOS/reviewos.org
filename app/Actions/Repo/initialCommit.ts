/**
 * Writing the first commit into a bare repository.
 *
 * There is no working tree here and there is not going to be one, so this is
 * plumbing rather than `git add` and `git commit`: each file becomes a blob,
 * the blobs become a tree, the tree becomes a commit, and the branch is pointed
 * at it. Checking out a worktree to make one commit would mean a temporary
 * directory per repository creation, and cleaning it up on every failure path.
 *
 * Every step is a separate git invocation on purpose. `fast-import` would do it
 * in one, and its input format is a stream where a byte count that disagrees
 * with the data silently produces a corrupt object - which is not a thing to
 * find out about later, on somebody's repository.
 */

import { runGit } from '../Git/git'
import type { ScaffoldFile } from './scaffold'
import { initialCommitMessage } from './scaffold'

export interface CommitAuthor {
  name: string
  email: string
}

export interface InitialCommitResult {
  ok: boolean
  sha?: string
  error?: string
}

/**
 * Non-executable file, as git records a mode.
 *
 * Everything scaffolded here is text somebody reads. Nothing generated needs
 * the executable bit, and handing one out by default is how a README ends up
 * marked executable in every repository this creates.
 */
const FILE_MODE = '100644'

/**
 * Commit a set of files onto a branch that has no commits yet.
 *
 * Refuses rather than overwrites if the branch already exists. This runs while
 * a repository is being created, so a branch already being there means
 * something else got in first - a push that raced the creation - and its work
 * is not this function's to discard.
 */
export async function writeInitialCommit(
  repositoryPath: string,
  branch: string,
  files: readonly ScaffoldFile[],
  author: CommitAuthor,
): Promise<InitialCommitResult> {
  if (files.length === 0)
    return { ok: false, error: 'Nothing to commit' }

  const ref = `refs/heads/${branch}`

  const existing = await runGit(repositoryPath, ['rev-parse', '--verify', '--quiet', ref])
  if (existing.ok && existing.stdout.trim())
    return { ok: false, error: 'That branch already has commits' }

  const entries: string[] = []

  for (const file of files) {
    // `-w` writes the object; without it git only prints what the sha would be
    // and the tree below then references an object that is not there.
    const blob = await runGit(repositoryPath, ['hash-object', '-w', '--stdin'], { input: file.content })
    if (!blob.ok)
      return { ok: false, error: `Could not store ${file.path}: ${blob.stderr}` }

    entries.push(`${FILE_MODE} blob ${blob.stdout.trim()}\t${file.path}`)
  }

  // `mktree` reads one entry per line and every file here sits at the root, so
  // there are no subtrees to build. A scaffold file with a slash in its path
  // would need a tree per directory, which is why nothing generates one.
  const tree = await runGit(repositoryPath, ['mktree'], { input: `${entries.join('\n')}\n` })
  if (!tree.ok)
    return { ok: false, error: `Could not build the tree: ${tree.stderr}` }

  // Author and committer are both passed explicitly. git falls back to a name
  // and email assembled from the host's user and hostname, so without these the
  // first commit in every repository is authored by whatever account the server
  // runs as - which is both wrong and a small disclosure about the host.
  const identity = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  }

  const commit = await runGit(
    repositoryPath,
    ['commit-tree', tree.stdout.trim(), '-m', initialCommitMessage(files)],
    { env: identity },
  )

  if (!commit.ok)
    return { ok: false, error: `Could not write the commit: ${commit.stderr}` }

  const sha = commit.stdout.trim()

  // The zero sha as the expected old value is what makes this an atomic
  // create: if anything pointed the branch somewhere between the check above
  // and here, this fails rather than discarding it.
  const updated = await runGit(repositoryPath, ['update-ref', ref, sha, '0'.repeat(40)])
  if (!updated.ok)
    return { ok: false, error: `Could not point ${branch} at the commit: ${updated.stderr}` }

  return { ok: true, sha }
}
