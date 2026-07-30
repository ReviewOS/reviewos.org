/**
 * Moving a branch, in a bare repository, without a working tree.
 *
 * A forge cannot check out a repository to merge a pull request: it would cost
 * a disk copy of the working tree per merge, and two merges at once would fight
 * over it. Everything here is git plumbing instead, which reads and writes
 * objects directly.
 *
 * Every path ends in `update-ref` with the branch's expected old value. That
 * guard is the concurrency story: if somebody pushed between the checks and the
 * merge, the update fails and nothing is lost.
 */

import { runGit } from '../Git/git'

export interface MergeInput {
  strategy: 'merge' | 'squash' | 'rebase'
  base: string
  headSha: string
  baseSha: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
}

export type MergeResult = { ok: true, sha: string } | { ok: false, error: string }

/**
 * Move the base branch, without a working tree.
 *
 * A bare repository has no checkout, so the merge is done with plumbing: build
 * the tree, write a commit against it, then move the ref with
 * `update-ref` guarded by its old value. That guard is what makes a concurrent
 * push and merge safe: if the branch moved since the rules were checked, the
 * update fails rather than discarding the push.
 */
export async function performMerge(path: string, input: MergeInput): Promise<MergeResult> {
  const env = {
    GIT_AUTHOR_NAME: input.authorName,
    GIT_AUTHOR_EMAIL: input.authorEmail,
    GIT_COMMITTER_NAME: input.authorName,
    GIT_COMMITTER_EMAIL: input.authorEmail,
  }

  if (input.strategy === 'rebase')
    return await performRebase(path, input, env)

  // `merge-tree` produces the merged tree, or reports the conflict, without
  // ever writing to a working directory.
  const tree = await runGit(path, ['merge-tree', '--write-tree', input.baseSha, input.headSha], { env })
  if (!tree.ok)
    return { ok: false, error: tree.stdout.trim() || tree.stderr.trim() || 'conflict' }

  const treeSha = tree.stdout.split('\n')[0]!.trim()
  const message = [input.subject, input.body].filter(Boolean).join('\n\n')

  // A merge commit keeps both histories; a squash keeps one commit whose parent
  // is the base, which is the whole point of squashing.
  const parents = input.strategy === 'merge'
    ? ['-p', input.baseSha, '-p', input.headSha]
    : ['-p', input.baseSha]

  const commit = await runGit(path, ['commit-tree', treeSha, ...parents, '-m', message], { env })
  if (!commit.ok)
    return { ok: false, error: commit.stderr.trim() }

  const sha = commit.stdout.trim()

  const update = await runGit(path, ['update-ref', `refs/heads/${input.base}`, sha, input.baseSha], { env })
  if (!update.ok)
    return { ok: false, error: 'The base branch moved while merging, so nothing was changed' }

  return { ok: true, sha }
}

/**
 * Replay the branch onto the base, keeping every commit.
 *
 * `git replay` is the only way to rebase in a bare repository: it works
 * entirely on objects, with no index and no checkout. Anything else would mean
 * checking out a copy of the repository on every merge.
 *
 * It is asked to print the ref update rather than apply it, so the ref still
 * moves through the same guarded `update-ref` as the other strategies. Some git
 * versions apply the update themselves by default, which would skip that guard
 * and let a merge overwrite a push that arrived a moment earlier.
 */
async function performRebase(
  path: string,
  input: MergeInput,
  env: Record<string, string>,
): Promise<MergeResult> {
  const range = [
    `--onto=${input.baseSha}`,
    `--ref=refs/heads/${input.base}`,
    `${input.baseSha}..${input.headSha}`,
  ]

  let replayed = await runGit(path, ['replay', '--ref-action=print', ...range], { env })

  // Older git has no --ref-action because printing was all it ever did.
  if (!replayed.ok && /unknown option|unrecognized/i.test(replayed.stderr))
    replayed = await runGit(path, ['replay', ...range], { env })

  if (!replayed.ok)
    return { ok: false, error: replayed.stderr.trim() || 'the branch could not be replayed onto the base' }

  // Each line is `update <ref> <new> <old>`.
  const line = replayed.stdout.split('\n').find(candidate => candidate.startsWith('update '))
  const sha = line?.trim().split(/\s+/)[2]

  if (!sha || !/^[0-9a-f]{40}$/.test(sha))
    return { ok: false, error: 'the replay produced no commit' }

  const update = await runGit(path, ['update-ref', `refs/heads/${input.base}`, sha, input.baseSha], { env })
  if (!update.ok)
    return { ok: false, error: 'The base branch moved while merging, so nothing was changed' }

  return { ok: true, sha }
}
