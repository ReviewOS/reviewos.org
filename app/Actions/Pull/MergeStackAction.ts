import { Action } from '@stacksjs/actions'
import { requirementsSatisfied, statusAsRun } from '../Checks/status'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { approvalsSatisfied, machineAccountsAmong } from './anchoring'
import { performMerge } from './apply'
import { isMergeStrategy, mergeBlockers, mergeCommitMessage, retargetStack } from './merge'
import { buildStack, landablePrefix } from './stack'

/**
 * Merge a whole stack, bottom first, in one action.
 *
 * The point of a stack is that the pieces are reviewed separately and land
 * together. Doing that by hand means merging the bottom, waiting for the child
 * to retarget, merging that, and so on, which is exactly the tedium the
 * workflow was meant to remove.
 *
 * Landing is contiguous from the bottom by definition: merging the third
 * without the second would take the second's commits along with it. So this
 * merges the longest run from the bottom that is ready, and stops at the first
 * that is not, reporting how far it got. A partial land is a correct outcome
 * rather than a failure, because the pieces that merged were each ready.
 */
export default new Action({
  name: 'MergeStack',
  description: 'Merge a stack of pull requests, bottom first',
  method: 'POST',

  async handle(request: RequestInstance) {
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

    const rows = await db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .execute()

    const members = rows.map((row) => ({
      id: Number(row.id),
      number: Number(row.number),
      title: String(row.title),
      state: String(row.state) as 'open' | 'closed' | 'merged',
      headBranch: String(row.head_branch),
      baseBranch: String(row.base_branch),
      stackParentId: row.stack_parent_id === null || row.stack_parent_id === undefined ? null : Number(row.stack_parent_id),
      draft: Boolean(row.draft),
    }))

    const target = members.find((member) => member.number === number)
    if (!target)
      return response.json({ error: 'No such pull request' }, 404)

    const stack = buildStack(members, target.id)

    // Every member's blockers, so the run that can land is decided on the same
    // rules a single merge would apply.
    const readiness = []
    for (const member of stack) {
      const row = rows.find((candidate: any) => Number(candidate.id) === member.id)
      readiness.push({ id: member.id, blockers: await blockersFor(repository, row) })
    }

    const landable = landablePrefix(stack, readiness)

    if (landable.length === 0) {
      const bottom = stack.find(member => member.state === 'open')
      const reason = readiness.find(entry => entry.id === bottom?.id)?.blockers ?? ['Nothing in this stack is ready to merge']

      return response.json({ error: 'This stack cannot be merged yet', blockers: reason }, 409)
    }

    const resolved = repositoryPath(String(request.get('owner')), repository.name)
    if (!resolved.ok)
      return response.json({ error: 'Repository not found' }, 404)

    const merged: number[] = []

    for (const member of landable) {
      const row = rows.find((candidate: any) => Number(candidate.id) === member.id)

      // Re-read the base: the previous member in this loop just moved it, and
      // merging against a stale value would be refused by the ref guard.
      const current = await db
        .selectFrom('pull_requests')
        .selectAll()
        .where('id', '=', member.id)
        .executeTakeFirst()

      if (!current || current.state !== 'open')
        break

      const baseSha = await headOf(resolved.path!, String(current.base_branch))
      if (!baseSha)
        break

      const message = mergeCommitMessage(strategy, {
        number: member.number,
        title: String(current.title),
        body: String(current.body ?? ''),
        headBranch: String(current.head_branch),
        baseBranch: String(current.base_branch),
        commits: [],
      })

      const result = await performMerge(resolved.path!, {
        strategy,
        base: String(current.base_branch),
        headSha: String(current.head_sha),
        baseSha,
        subject: message.subject,
        body: message.body,
        authorName: user.handle,
        authorEmail: `${user.handle}@users.noreply.reviewos.org`,
      })

      // A failure part way through leaves everything below it merged, which is
      // correct: those were ready and did land. Stopping here is what keeps the
      // stack's order intact.
      if (!result.ok)
        break

      await db
        .updateTable('pull_requests')
        .set({
          state: 'merged',
          merge_commit_sha: result.sha,
          merged_at: new Date().toISOString(),
          merged_by_id: user.id,
        })
        .where('id', '=', member.id)
        .execute()

      const children = await db
        .selectFrom('pull_requests')
        .select(['id', 'base_branch', 'stack_parent_id'])
        .where('stack_parent_id', '=', member.id)
        .where('state', '=', 'open')
        .execute()

      const moves = retargetStack(
        {
          id: member.id,
          headBranch: member.headBranch,
          baseBranch: String(current.base_branch),
          stackParentId: member.stackParentId,
        },
        children.map((child: any) => ({
          id: Number(child.id),
          baseBranch: String(child.base_branch),
          stackParentId: child.stack_parent_id ? Number(child.stack_parent_id) : null,
        })),
      )

      for (const move of moves) {
        // Same rule as the single merge: a child adopting the landed base
        // adopts its sha, or the eventual merge is refused as "base moved".
        const adoptedBase = move.baseBranch === String(current.base_branch)

        await db
          .updateTable('pull_requests')
          .set({
            base_branch: move.baseBranch,
            stack_parent_id: move.stackParentId,
            ...(adoptedBase ? { base_sha: result.sha, mergeable_state: 'unknown' } : {}),
          })
          .where('id', '=', move.id)
          .execute()
      }

      merged.push(member.number)
      void row
    }

    return response.json({
      merged,
      remaining: stack
        .filter(member => member.state === 'open' && !merged.includes(member.number))
        .map(member => member.number),
      strategy,
    })
  },
})

/** The blockers for one pull request, on the same rules a single merge uses. */
async function blockersFor(repository: any, row: any): Promise<string[]> {
  if (!row)
    return ['This pull request could not be read']

  const protection = await db
    .selectFrom('protected_branches')
    .selectAll()
    .where('repository_id', '=', repository.id)
    .where('pattern', '=', row.base_branch)
    .executeTakeFirst()

  let requiredChecks: string[] = []
  try {
    const parsed = JSON.parse(String(protection?.required_checks ?? '[]'))
    if (Array.isArray(parsed))
      requiredChecks = parsed.map(String)
  }
  catch {
    return ['The required checks for this branch could not be read']
  }

  const reviews = await db
    .selectFrom('pull_request_reviews')
    .select(['reviewer_id', 'state', 'commit_sha'])
    .where('pull_request_id', '=', Number(row.id))
    .orderBy('id', 'asc')
    .execute()

  const machineAccounts = await machineAccountsAmong([
    ...reviews.map((review) => Number(review.reviewer_id)),
    Number(row.author_id),
  ])

  const machineReviewers = machineAccounts

  const approval = approvalsSatisfied({
    reviews: reviews.map((review) => ({
      reviewerId: Number(review.reviewer_id),
      state: String(review.state),
      commitSha: review.commit_sha as string | null,
      machine: machineReviewers.has(Number(review.reviewer_id)),
    })),
    headSha: row.head_sha as string | null,
    requiredApprovals: Number(protection?.required_approvals ?? 0),
    dismissStaleReviews: Boolean(protection?.dismiss_stale_reviews),
    // Every member of a stack belongs to the same repository, so one setting
    // governs the lot.
    countMachineApprovals: Boolean((repository as any).count_machine_approvals),
  })

  const unresolved = await db
    .selectFrom('review_threads')
    .select(db.fn.count('id').as('count'))
    .where('pull_request_id', '=', Number(row.id))
    .where('resolved', '=', false)
    .executeTakeFirst()

  const checkRows = requiredChecks.length === 0
    ? []
    : await db
        .selectFrom('check_runs')
        .select(['name', 'status', 'conclusion', 'started_at'])
        .where('repository_id', '=', repository.id)
        .where('head_sha', '=', row.head_sha)
        .execute()

  // Statuses too: a required check is a name, and either reporting API may be
  // the one answering to it. See `MergePullRequestAction` for what consulting
  // only `check_runs` did to a repository whose CI posts statuses.
  const statusRows = requiredChecks.length === 0
    ? []
    : await db
        .selectFrom('commit_statuses')
        .select(['context', 'state', 'created_at'])
        .where('repository_id', '=', repository.id)
        .where('sha', '=', row.head_sha)
        .execute()

  const checks = requirementsSatisfied(
    [
      ...statusRows.map((entry) => statusAsRun(entry)),
      ...checkRows.map((entry) => ({
        name: String(entry.name),
        status: entry.status,
        conclusion: entry.conclusion,
        startedAt: Date.parse(String(entry.started_at ?? '')) || 0,
      })),
    ],
    requiredChecks,
  )

  // The stack rule itself is left out: `landablePrefix` enforces the ordering,
  // and including it here would report every member as blocked by the one
  // below even while the whole stack is landing in order.
  return mergeBlockers(
    {
      state: row.state,
      draft: Boolean(row.draft),
      mergeable: row.mergeable_state === 'clean' ? true : (row.mergeable_state === 'dirty' ? false : null),
      stackParent: null,
    },
    {
      requiredApprovals: Number(protection?.required_approvals ?? 0),
      requireThreadsResolved: Boolean(protection?.require_conversation_resolution),
      requireLinearHistory: Boolean(protection?.require_linear_history),
      allowedStrategies: ['merge', 'squash', 'rebase'],
      requiredChecks,
      requireHumanApprovalForAgents: Boolean(protection?.require_human_approval_for_agents),
    },
    {
      approvals: approval.approvals,
      blockingReviews: approval.blocking,
      uncountedApprovals: approval.uncounted,
      authorIsMachine: machineAccounts.has(Number(row.author_id)),
      humanApprovals: approval.human,
      unresolvedThreads: Number(unresolved?.count ?? 0),
      checks,
    },
    'merge',
  )
}

/** The commit a branch points at right now. */
async function headOf(path: string, branch: string): Promise<string | null> {
  const { runGit } = await import('../Git/git')
  const result = await runGit(path, ['rev-parse', '--verify', `refs/heads/${branch}`])

  return result.ok ? result.stdout.trim() : null
}
