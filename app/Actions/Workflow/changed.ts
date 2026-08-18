/**
 * What a push changed, for the workflows that filter on it.
 *
 * `paths:` and `paths-ignore:` are the two filters people rely on most - a
 * documentation change that starts a twelve-minute test suite is the reason
 * `paths-ignore` exists - and both of them need this list. Without it the
 * dispatcher errs towards running, which is the safe direction and also means
 * the filters do nothing at all.
 *
 * Read with plumbing from the bare repository, like everything else here.
 * Nothing is checked out.
 */

import { isSafeRevision, runGit } from '../Git/git'

/** git's own spelling of "this ref did not exist before". */
const EMPTY = '0'.repeat(40)

/**
 * A ceiling on how many paths are read from one push.
 *
 * A push that rewrites a million files is rare, real, and not worth reading
 * into memory to answer a question about `docs/**`. Past the limit the answer
 * is "unknown", which the dispatcher reads as "run it" - the visible failure
 * rather than the invisible one.
 */
export const MAX_CHANGED_PATHS = 5000

/**
 * The paths a push touched, or an empty list when that cannot be known.
 *
 * Empty means unknown here, deliberately: it is what `pushStartsRun` already
 * treats as "no information, so run", and inventing a distinction between "no
 * files changed" and "we could not tell" would be a distinction the caller has
 * no use for. A push that genuinely changes nothing does not reach this.
 */
export async function changedPaths(
  gitDir: string,
  before: string,
  after: string,
): Promise<string[]> {
  if (!isSafeRevision(after))
    return []

  /*
   * A new branch or tag has no `before`.
   *
   * Diffing against the empty tree would list every file in the repository,
   * which is technically true and useless: pushing a branch of one commit
   * would look like it changed everything. Actions treats a new ref as
   * changing what its own commits introduced, so this asks for the tip
   * commit's own diff and lets the caller err towards running when that is
   * not knowable.
   */
  const isNew = !before || before === EMPTY || !isSafeRevision(before)

  const result = isNew
    ? await runGit(gitDir, ['show', '--name-only', '--pretty=format:', '--no-color', after], { timeoutMs: 30_000 })
    : await runGit(gitDir, ['diff', '--name-only', '--no-color', `${before}..${after}`], { timeoutMs: 30_000 })

  if (!result.ok)
    return []

  const paths = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  // Past the ceiling the honest answer is "unknown" rather than a truncated
  // list, which would exclude a push whose only interesting file fell off the
  // end.
  if (paths.length > MAX_CHANGED_PATHS)
    return []

  return [...new Set(paths)]
}

/**
 * The head commit's subject and body, for a job's `if:`.
 *
 * `%B` rather than `%s`, because `contains(github.event.head_commit.message,
 * '[skip ci]')` is written against the whole message in every workflow that
 * uses it - and half the people who write `[skip ci]` put it on the second
 * line.
 *
 * An empty string when the commit cannot be read, which is the same convention
 * the changed paths follow: unknown reads as *nothing to match on* rather than
 * as a reason to refuse a run.
 */
export async function commitMessage(gitDir: string, sha: string): Promise<string> {
  if (!gitDir || !sha)
    return ''

  const result = await runGit(gitDir, ['show', '--no-patch', '--format=%B', sha]).catch(() => null)

  return result?.code === 0 ? result.stdout.trim() : ''
}
