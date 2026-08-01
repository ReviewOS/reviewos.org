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
 * Fetch the remote into the bare repository.
 *
 * `--prune` is what makes a deletion upstream become a deletion here; without
 * it the branch list only ever grows. `--tags` because a release list that
 * stops updating is worse than no release list.
 *
 * The credential is passed by URL rather than written to disk: a token in a
 * config file is a token in every backup.
 */
export async function fetchMirror(
  repositoryPath: string,
  remoteUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  const before = await snapshotRefs(repositoryPath)

  const result = await runGit(
    repositoryPath,
    ['fetch', '--prune', '--tags', '--force', remoteUrl, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
    // A mirror of a large repository is slow the first time and quick after,
    // so the ceiling is generous rather than tuned to the common case.
    { timeoutMs: options.timeoutMs ?? 15 * 60 * 1000 },
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
