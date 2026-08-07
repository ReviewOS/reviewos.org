/**
 * Restoring a merged pull request's head branch.
 *
 * The sha is on the pull request, so this is a ref write - but a guarded one,
 * the same discipline every ref move in this codebase follows: the create is
 * conditional on the branch not existing, so restoring twice, or restoring
 * while somebody pushes a new branch under the old name, refuses instead of
 * clobbering.
 */

import { runGit } from '../Git/git'

/** Whether a branch currently exists in a bare repository. */
export async function branchExists(diskPath: string, branch: string): Promise<boolean> {
  if (!branch)
    return false

  const result = await runGit(diskPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.ok
}

/**
 * Whether a restore may happen, as a rule over values.
 *
 * Merged only. A closed pull request's branch was not deleted by this forge -
 * delete-on-merge runs on merge - and an open one still has its branch, so
 * "merged, and the branch is gone" is the whole population this exists for.
 */
export function mayRestoreHeadBranch(input: {
  state: string
  headBranch: string
  headSha: string
  exists: boolean
}): { ok: true } | { ok: false, error: string, status: number } {
  if (input.state !== 'merged')
    return { ok: false, error: 'Only a merged pull request’s branch can be restored', status: 409 }

  if (!input.headBranch || !input.headSha)
    return { ok: false, error: 'This pull request does not record a branch to restore', status: 409 }

  if (input.exists)
    return { ok: false, error: 'The branch already exists', status: 409 }

  return { ok: true }
}

/**
 * Write the branch back, guarded against it having appeared meanwhile.
 *
 * The all-zeroes old value is git's spelling of "must not exist": between the
 * check above and this write, somebody may have pushed a branch under the old
 * name, and overwriting theirs with an old sha would be losing their work to a
 * button. The other way this fails is the commit no longer being in the
 * repository at all - pruned since the merge - which is reported as what it
 * is rather than as a shrug.
 */
export async function restoreHeadBranch(
  diskPath: string,
  branch: string,
  sha: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const created = await runGit(diskPath, [
    'update-ref',
    `refs/heads/${branch}`,
    sha,
    '0'.repeat(40),
  ])

  if (created.ok)
    return { ok: true }

  const missingObject = /not a valid SHA1|bad object|missing object/i.test(created.stderr)

  return {
    ok: false,
    error: missingObject
      ? 'The merged commit is no longer in the repository, so there is nothing to restore'
      : 'The branch appeared while restoring it, and was left alone',
  }
}
