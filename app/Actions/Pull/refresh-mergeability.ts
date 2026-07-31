/**
 * Keeping a pull request's cached mergeability current.
 *
 * The rules are in `mergeability.ts` and stay pure; this is the part that reads
 * and writes the row. Split because the interesting decisions (what git's output
 * means, when a cached answer is stale) are worth testing without a database,
 * and the rest is two queries.
 */

import type { Mergeability } from './mergeability'
import { repositoryPath } from '../Git/storage'
import { checkMergeability, isCurrent, toMergeableState } from './mergeability'

export interface CachedMergeability extends Mergeability {
  /** True when this was computed now rather than read from the row. */
  recomputed: boolean
}

export interface PullRequestRow {
  id: number
  base_sha: string
  head_sha: string
  mergeable_state?: string | null
  mergeable_base_sha?: string | null
  mergeable_head_sha?: string | null
  mergeable_conflicts?: string | null
}

/**
 * The mergeability of a pull request, computing it only when the stored answer
 * no longer matches the commits it was computed from.
 *
 * `force` exists for the endpoint somebody reaches for when they have just
 * fixed the conflict and do not want to wait to be believed.
 */
export async function refreshMergeability(
  owner: string,
  repositoryName: string,
  pullRequest: PullRequestRow,
  options: { force?: boolean } = {},
): Promise<CachedMergeability> {
  const cached = {
    baseSha: pullRequest.mergeable_base_sha ?? null,
    headSha: pullRequest.mergeable_head_sha ?? null,
  }

  const current = { baseSha: pullRequest.base_sha, headSha: pullRequest.head_sha }

  if (!options.force && isCurrent(cached, current)) {
    return {
      ...fromRow(pullRequest),
      recomputed: false,
    }
  }

  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return { state: 'unknown', treeSha: null, conflictingPaths: [], recomputed: false }

  const computed = await checkMergeability(resolved.path!, current.baseSha, current.headSha)

  // An unknown answer is not cached. Caching it would mean a transient failure
  // (git timing out, the repository briefly locked) sticks until one of the
  // branches happens to move, and the interface keeps saying it has not been
  // checked while nothing tries again.
  if (computed.state !== 'unknown') {
    await db
      .updateTable('pull_requests')
      .set({
        mergeable_state: toMergeableState(computed),
        mergeable_base_sha: current.baseSha,
        mergeable_head_sha: current.headSha,
        mergeable_conflicts: computed.conflictingPaths.join('\n'),
      })
      .where('id', '=', pullRequest.id)
      .execute()
  }

  return { ...computed, recomputed: true }
}

/** The stored answer, as the same shape the computation returns. */
export function fromRow(pullRequest: PullRequestRow): Mergeability {
  const conflictingPaths = String(pullRequest.mergeable_conflicts ?? '')
    .split('\n')
    .filter(Boolean)

  switch (pullRequest.mergeable_state) {
    case 'clean':
      return { state: 'clean', treeSha: null, conflictingPaths: [] }
    case 'dirty':
      return { state: 'conflicted', treeSha: null, conflictingPaths }
    default:
      return { state: 'unknown', treeSha: null, conflictingPaths: [] }
  }
}
