import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { refreshMergeability } from './refresh-mergeability'

/**
 * Recompute whether a pull request merges cleanly.
 *
 * Reading a pull request does not need write access, so this only needs read.
 * Nothing about it changes a ref: `git merge-tree` merges in memory and writes
 * an object, and the tests hold it to that.
 *
 * The answer is cached against the two commits it was computed from, so the
 * ordinary path is free and this endpoint exists for the moment somebody has
 * just fixed the conflict and does not want to wait to be believed.
 */
export default new Action({
  name: 'RefreshMergeability',
  description: 'Recompute whether a pull request merges cleanly',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select([
        'id',
        'state',
        'base_sha',
        'head_sha',
        'mergeable_state',
        'mergeable_base_sha',
        'mergeable_head_sha',
        'mergeable_conflicts',
      ])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const result = await refreshMergeability(
      String(request.get('owner')),
      repository.name,
      {
        id: Number(pullRequest.id),
        base_sha: String(pullRequest.base_sha),
        head_sha: String(pullRequest.head_sha),
        mergeable_state: pullRequest.mergeable_state as string | null,
        mergeable_base_sha: pullRequest.mergeable_base_sha as string | null,
        mergeable_head_sha: pullRequest.mergeable_head_sha as string | null,
        mergeable_conflicts: pullRequest.mergeable_conflicts as string | null,
      },
      { force: Boolean(request.get('force')) },
    )

    // A recompute that came back clean may be the last requirement. Does
    // nothing unless somebody armed auto-merge, and never throws.
    if (result.state === 'clean') {
      const { attemptAutoMerge } = await import('./autoMerge')
      await attemptAutoMerge(Number(pullRequest.id))
    }

    return response.json({
      number,
      state: result.state,
      // Named rather than counted. "This branch has conflicts" sends somebody
      // to their terminal to find out which files; they are already known here.
      conflicting_paths: result.conflictingPaths,
      recomputed: result.recomputed,
    })
  },
})
