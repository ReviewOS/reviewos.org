import { Action } from '@stacksjs/actions'
import { runGit } from '../Git/git'
import { performMerge } from './apply'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { approvalsSatisfied } from './anchoring'
import { isMergeStrategy, mergeBlockers, mergeCommitMessage, retargetStack } from './merge'
import { requirementsSatisfied } from '../Checks/status'

/**
 * Merge a pull request.
 *
 * The order matters: every rule is checked before git is touched, and the row
 * is only marked merged once git has said the ref moved. A row that says merged
 * when the branch did not move is the one inconsistency nobody can repair by
 * hand afterwards, because the pull request will not offer to merge again.
 */
export default new Action({
  name: 'MergePullRequest',
  description: 'Merge an open pull request',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:merge')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const strategy = String(request.get('strategy') ?? 'merge')
    if (!isMergeStrategy(strategy))
      return response.json({ error: 'Unknown merge strategy' }, 422)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const protection = await db
      .selectFrom('protected_branches')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .where('pattern', '=', pullRequest.base_branch)
      .executeTakeFirst()

    // `required_checks` is stored as a JSON array of names. A malformed value
    // must not be read as "no checks required" — that would turn a corrupt
    // setting into a silently weaker branch rule — so it is treated as a rule
    // nothing can satisfy until somebody fixes it.
    let requiredChecks: string[] = []
    let checksUnreadable = false
    try {
      const parsed = JSON.parse(String(protection?.required_checks ?? '[]'))
      if (Array.isArray(parsed))
        requiredChecks = parsed.map(String)
      else
        checksUnreadable = protection !== undefined
    }
    catch {
      checksUnreadable = protection !== undefined
    }

    const rules = {
      requiredApprovals: Number(protection?.required_approvals ?? 0),
      requireThreadsResolved: Boolean(protection?.require_conversation_resolution),
      requireLinearHistory: Boolean(protection?.require_linear_history),
      allowedStrategies: ['merge', 'squash', 'rebase'] as const,
      requiredChecks,
    }

    const reviews = await db
      .selectFrom('pull_request_reviews')
      .select(['reviewer_id', 'state', 'commit_sha'])
      .where('pull_request_id', '=', Number(pullRequest.id))
      .orderBy('id', 'asc')
      .execute()

    const readinessReviews = reviews.map((review: any) => ({
      reviewerId: Number(review.reviewer_id),
      state: String(review.state),
      commitSha: review.commit_sha as string | null,
    }))

    const approval = approvalsSatisfied({
      reviews: readinessReviews,
      headSha: pullRequest.head_sha as string | null,
      requiredApprovals: rules.requiredApprovals,
      dismissStaleReviews: Boolean(protection?.dismiss_stale_reviews),
    })

    const unresolved = await db
      .selectFrom('review_threads')
      .select(db.fn.count('id').as('count'))
      .where('pull_request_id', '=', Number(pullRequest.id))
      .where('resolved', '=', false)
      .executeTakeFirst()

    const parent = pullRequest.stack_parent_id
      ? await db
          .selectFrom('pull_requests')
          .select(['state'])
          .where('id', '=', Number(pullRequest.stack_parent_id))
          .executeTakeFirst()
      : null

    const checkRuns = requiredChecks.length === 0
      ? []
      : await db
          .selectFrom('check_runs')
          .select(['name', 'status', 'conclusion', 'started_at'])
          .where('repository_id', '=', repository.id)
          .where('head_sha', '=', pullRequest.head_sha)
          .execute()

    const checkResult = requirementsSatisfied(
      checkRuns.map((entry: any) => ({
        name: String(entry.name),
        status: entry.status,
        conclusion: entry.conclusion,
        startedAt: Date.parse(String(entry.started_at ?? '')) || 0,
      })),
      requiredChecks,
    )

    const blockers = mergeBlockers(
      {
        state: pullRequest.state as 'open' | 'closed' | 'merged',
        draft: Boolean(pullRequest.draft),
        mergeable: pullRequest.mergeable_state === 'clean' ? true : pullRequest.mergeable_state === 'dirty' ? false : null,
        stackParent: parent ? { state: parent.state as 'open' | 'closed' | 'merged' } : null,
      },
      rules,
      {
        approvals: approval.approvals,
        blockingReviews: approval.blocking,
        unresolvedThreads: Number(unresolved?.count ?? 0),
        checks: checkResult,
      },
      strategy,
    )

    if (checksUnreadable)
      blockers.push('The required checks for this branch could not be read')

    if (blockers.length > 0)
      return response.json({ error: 'This pull request cannot be merged', blockers }, 409)

    const resolved = repositoryPath(String(request.get('owner')), repository.name)
    if (!resolved.ok)
      return response.json({ error: 'Repository not found' }, 404)

    const commits = await subjectsOnBranch(resolved.path!, String(pullRequest.base_sha), String(pullRequest.head_sha))
    const message = mergeCommitMessage(strategy, {
      number,
      title: String(pullRequest.title),
      body: String(pullRequest.body ?? ''),
      headBranch: String(pullRequest.head_branch),
      baseBranch: String(pullRequest.base_branch),
      commits,
    })

    const merged = await performMerge(resolved.path!, {
      strategy,
      base: String(pullRequest.base_branch),
      headSha: String(pullRequest.head_sha),
      baseSha: String(pullRequest.base_sha),
      subject: message.subject,
      body: message.body,
      authorName: user.handle,
      authorEmail: `${user.handle}@users.noreply.reviewos.org`,
    })

    if (!merged.ok)
      return response.json({ error: 'The merge failed', detail: merged.error }, 409)

    await db
      .updateTable('pull_requests')
      .set({
        state: 'merged',
        merge_commit_sha: merged.sha,
        merged_at: new Date().toISOString(),
        merged_by_id: user.id,
      })
      .where('id', '=', Number(pullRequest.id))
      .execute()

    // Anything stacked on this one now points at a branch that has landed.
    const children = await db
      .selectFrom('pull_requests')
      .select(['id', 'base_branch', 'stack_parent_id'])
      .where('stack_parent_id', '=', Number(pullRequest.id))
      .where('state', '=', 'open')
      .execute()

    const moves = retargetStack(
      {
        id: Number(pullRequest.id),
        headBranch: String(pullRequest.head_branch),
        baseBranch: String(pullRequest.base_branch),
        stackParentId: pullRequest.stack_parent_id ? Number(pullRequest.stack_parent_id) : null,
      },
      children.map((child: any) => ({
        id: Number(child.id),
        baseBranch: String(child.base_branch),
        stackParentId: child.stack_parent_id ? Number(child.stack_parent_id) : null,
      })),
    )

    for (const move of moves) {
      await db
        .updateTable('pull_requests')
        .set({ base_branch: move.baseBranch, stack_parent_id: move.stackParentId })
        .where('id', '=', move.id)
        .execute()
    }

    return response.json({
      number,
      state: 'merged',
      strategy,
      merge_commit_sha: merged.sha,
      retargeted: moves.map(move => move.id),
    })
  },
})

/** Commit subjects on the head that are not on the base, oldest first. */
async function subjectsOnBranch(path: string, baseSha: string, headSha: string): Promise<string[]> {
  const result = await runGit(path, ['log', '--reverse', '--format=%s', `${baseSha}..${headSha}`])

  return result.ok ? result.stdout.split('\n').filter(Boolean) : []
}
