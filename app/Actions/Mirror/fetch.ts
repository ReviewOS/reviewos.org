/**
 * Fetching a mirror's remote.
 *
 * The impure half: it spawns git. Everything that decides what a fetch *meant*
 * lives in `sync.ts`, so this stays small enough to read in one go.
 */

import { runGit } from '../Git/git'
import { parseRefSnapshot, type RefSnapshot } from './sync'

export interface FetchOutcome {
  ok: boolean
  before: RefSnapshot
  after: RefSnapshot
  /** Present when the fetch failed, for the mirror row and the interface. */
  error: string | null
}

/** Snapshot every ref, so a sync can say what moved rather than only that it ran. */
export async function snapshotRefs(repositoryPath: string): Promise<RefSnapshot> {
  const result = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname) %(objectname)'])
  return result.ok ? parseRefSnapshot(result.stdout) : {}
}

/**
 * The refs a proposal lives on, per forge.
 *
 * A pull request's commits are not on a branch of the repository being
 * mirrored - they are usually on a fork - so `refs/heads/*` never brings them
 * across. GitHub, Gitea and Forgejo all publish them at `refs/pull/<n>/head`;
 * GitLab calls the same thing `refs/merge-requests/<n>/head`.
 *
 * Without this a mirror can show a pull request's title and not its diff, and
 * only for the ones that have not been touched since the clone: the initial
 * clone happened to bring these refs along, nothing updated them afterwards,
 * and every push to an open proposal left the mirror pointing at a commit it
 * did not have. `git diff` then fails with *Invalid symmetric difference
 * expression*, which reads as a broken page rather than as a missing object.
 *
 * A forge this is not written for fetches branches and tags as before, rather
 * than being handed a refspec its server will reject.
 */
export function proposalRefspec(provider: string | null | undefined): string | null {
  switch (String(provider ?? '').toLowerCase()) {
    case 'github':
    case 'gitea':
    case 'forgejo':
      return '+refs/pull/*/head:refs/pull/*/head'
    case 'gitlab':
      return '+refs/merge-requests/*/head:refs/merge-requests/*/head'
    default:
      return null
  }
}

/**
 * Fetch the remote into the bare repository.
 *
 * `--prune` is what makes a deletion upstream become a deletion here; without
 * it the branch list only ever grows. `--tags` because a release list that
 * stops updating is worse than no release list. And the proposal refs above,
 * because a mirror whose pull requests have no diff is a mirror of the half
 * this product does not exist for.
 *
 * The credential is passed by URL rather than written to disk: a token in a
 * config file is a token in every backup.
 */
export async function fetchMirror(
  repositoryPath: string,
  remoteUrl: string,
  options: { timeoutMs?: number, provider?: string | null } = {},
): Promise<FetchOutcome> {
  const before = await snapshotRefs(repositoryPath)

  const proposals = proposalRefspec(options.provider)

  const result = await runGit(
    repositoryPath,
    [
      'fetch',
      '--prune',
      '--tags',
      '--force',
      remoteUrl,
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
      ...(proposals ? [proposals] : []),
    ],
    // A mirror of a large repository is slow the first time and quick after,
    // so the ceiling is generous rather than tuned to the common case.
    // `background`: a fetch is a job, and the queue holds what the class
    // will not run yet.
    { timeoutMs: options.timeoutMs ?? 15 * 60 * 1000, priority: 'background' },
  )

  if (!result.ok) {
    return {
      ok: false,
      before,
      after: before,
      // git puts the useful line on stderr, and the last one is the reason.
      error: (result.stderr || 'fetch failed').trim().split('\n').slice(-1)[0] ?? 'fetch failed',
    }
  }

  return { ok: true, before, after: await snapshotRefs(repositoryPath), error: null }
}

/**
 * Whether `oldSha` is still reachable from `newSha`.
 *
 * The question `isForcePush` needs answered and cannot answer itself. A missing
 * object counts as "not an ancestor": if the old commit is gone, history was
 * certainly rewritten.
 */
export async function isAncestor(repositoryPath: string, oldSha: string, newSha: string): Promise<boolean> {
  const result = await runGit(repositoryPath, ['merge-base', '--is-ancestor', oldSha, newSha])
  return result.ok
}
