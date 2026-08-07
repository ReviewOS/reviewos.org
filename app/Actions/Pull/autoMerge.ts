/**
 * Auto-merge: the merge button, pressed on your behalf when the answer is yes.
 *
 * Arming stores two facts on the pull request - the strategy, and who asked -
 * and every event that could change the answer calls `attemptAutoMerge`: a
 * review landing, a thread resolving, a push arriving, mergeability being
 * refreshed. That is what "as soon as" means here: at the next event that
 * could have satisfied the requirements, which is exactly when the
 * requirements change. There is nothing to poll, and when the checks API
 * lands (phase 9) its report action calls the same function.
 *
 * The attempt IS `MergePullRequestAction`, invoked as the arming user with a
 * synthesized request. Deliberately: that action owns every rule - protection,
 * allowed strategies, message templates, stack retargeting, branch deletion,
 * issue closing - and a second path through merging would be a second place
 * for one of them to quietly stop being right. A refused attempt is an
 * ordinary outcome, not an error: the requirements are not met yet and the
 * arm stays armed. Two events attempting at once are both safe, because the
 * merge itself ends in the guarded update-ref that makes exactly one land.
 */

export interface AutoMergeAttempt {
  attempted: boolean
  merged: boolean
  reason?: string
}

/** Never throws: this runs as a tail on other actions' successes. */
export async function attemptAutoMerge(pullRequestId: number): Promise<AutoMergeAttempt> {
  try {
    const pullRequest: any = await db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'state', 'repository_id', 'auto_merge_strategy', 'auto_merge_by_id'])
      .where('id', '=', Number(pullRequestId))
      .executeTakeFirst()

    if (!pullRequest || pullRequest.state !== 'open' || !pullRequest.auto_merge_strategy || !pullRequest.auto_merge_by_id)
      return { attempted: false, merged: false, reason: 'not armed' }

    const repository: any = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id'])
      .where('id', '=', Number(pullRequest.repository_id))
      .executeTakeFirst()

    if (!repository)
      return { attempted: false, merged: false, reason: 'no repository' }

    const ownerTable = repository.owner_type === 'organization' ? 'organizations' : 'users'
    const owner: any = await db
      .selectFrom(ownerTable)
      .select(['handle'])
      .where('id', '=', Number(repository.owner_id))
      .executeTakeFirst()

    if (!owner?.handle)
      return { attempted: false, merged: false, reason: 'no owner' }

    // An unknown mergeability honestly blocks a merge, and the event that
    // brought us here may be the one that made it stale. Refresh first - a
    // cache hit costs one row read - so the attempt judges the branch as it
    // is, not as it was when somebody last opened the page.
    try {
      const fresh: any = await db
        .selectFrom('pull_requests')
        .select(['base_sha', 'head_sha', 'mergeable_state', 'mergeable_base_sha', 'mergeable_head_sha', 'mergeable_conflicts'])
        .where('id', '=', Number(pullRequest.id))
        .executeTakeFirst()

      const { refreshMergeability } = await import('./refresh-mergeability')
      await refreshMergeability(String(owner.handle), String(repository.name), {
        id: Number(pullRequest.id),
        base_sha: String(fresh.base_sha),
        head_sha: String(fresh.head_sha),
        mergeable_state: fresh.mergeable_state,
        mergeable_base_sha: fresh.mergeable_base_sha,
        mergeable_head_sha: fresh.mergeable_head_sha,
        mergeable_conflicts: fresh.mergeable_conflicts,
      })
    }
    catch {
      // The attempt below reads whatever is stored; a stale unknown refuses,
      // which errs the safe way.
    }

    const values: Record<string, unknown> = {
      owner: String(owner.handle),
      repo: String(repository.name),
      number: Number(pullRequest.number),
      strategy: String(pullRequest.auto_merge_strategy),
    }

    const { default: MergePullRequest } = await import('./MergePullRequestAction')

    const answer: any = await MergePullRequest.handle({
      get: (key: string) => values[key],
      user: async () => ({ id: Number(pullRequest.auto_merge_by_id) }),
      headers: { get: () => null },
    })

    const body = await answer.json().catch(() => null)
    const merged = body?.state === 'merged'

    return {
      attempted: true,
      merged,
      reason: merged ? undefined : String(body?.error ?? (Array.isArray(body?.blockers) ? body.blockers.join('; ') : 'not ready')),
    }
  }
  catch {
    return { attempted: false, merged: false, reason: 'attempt failed' }
  }
}

/**
 * Attempt every armed, open pull request on the named branches.
 *
 * The push job's tail: a push can satisfy requirements for the pull request
 * whose head moved (the conflict fixed) and for the ones whose *base* moved
 * (linear-history satisfied by somebody else landing), so both are asked.
 */
export async function attemptAutoMergeOnBranches(repositoryId: number, branches: readonly string[]): Promise<number> {
  if (branches.length === 0)
    return 0

  let merged = 0

  try {
    const rows: any[] = await db
      .selectFrom('pull_requests')
      .select(['id', 'head_branch', 'base_branch'])
      .where('repository_id', '=', Number(repositoryId))
      .where('state', '=', 'open')
      .execute()

    const touched = new Set(branches)

    for (const row of rows) {
      if (!touched.has(String(row.head_branch)) && !touched.has(String(row.base_branch)))
        continue

      const attempt = await attemptAutoMerge(Number(row.id))
      if (attempt.merged)
        merged += 1
    }
  }
  catch {
    // The push happened; the arms stay armed for the next event.
  }

  return merged
}
