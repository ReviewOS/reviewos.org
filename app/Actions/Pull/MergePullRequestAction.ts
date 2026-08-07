import { Action } from '@stacksjs/actions'
import { closingTargets, withoutSelf } from '../Issue/closing'
import { runGit } from '../Git/git'
import { performMerge } from './apply'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { recountOpenIssues } from '../Repo/counters'
import { updateWhereIn } from '../Support/rows'
import { approvalsSatisfied } from './anchoring'
import { allowedStrategies, defaultStrategy, isMergeStrategy, mayDeleteHeadBranch, mergeBlockers, mergeCommitMessage, retargetStack } from './merge'
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

    // The repository's own default when the caller does not name one, so a
    // client that has never heard of the setting still lands branches the way
    // the repository asked to have them landed.
    const strategy = String(request.get('strategy') ?? defaultStrategy(repository as any))
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
      // From the repository rather than hard-coded. A repository that only
      // allows squashes says so here, and `mergeBlockers` turns it into a
      // sentence rather than a silent substitution.
      allowedStrategies: allowedStrategies(repository as any),
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

    // The caller's words win over the template's. Somebody editing a squash
    // message at merge time is writing the only commit message that change will
    // ever have, and a template that overrode it would make the field a lie.
    // Absent means use the template; empty means they deleted it, which for a
    // subject is not a commit message anybody can read, so the template stands.
    const givenSubject = String(request.get('subject') ?? '').trim()
    const givenBody = request.get('body_text')

    const merged = await performMerge(resolved.path!, {
      strategy,
      base: String(pullRequest.base_branch),
      headSha: String(pullRequest.head_sha),
      baseSha: String(pullRequest.base_sha),
      subject: givenSubject || message.subject,
      body: givenBody === undefined ? message.body : String(givenBody),
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

    // The head branch, if this repository asked for it to go.
    //
    // After the row says merged, never before: a delete that ran first and then
    // failed to record the merge would leave a pull request that still offers
    // to merge a branch which no longer exists. And never when something is
    // stacked on it - a child pull request's own base is this branch until it
    // is retargeted below, and deleting it first is deleting the thing they are
    // proposed against.
    const head = String(pullRequest.head_branch)

    // Every other open pull request built on this branch, which is both the
    // ones stacked on this pull request and any that simply share a head. The
    // rule itself is `mayDeleteHeadBranch`, tested on its own; this only counts.
    const stillOnHead = await db
      .selectFrom('pull_requests')
      .select(db.fn.count('id').as('count'))
      .where('repository_id', '=', repository.id)
      .where('head_branch', '=', head)
      .where('state', '=', 'open')
      .where('id', '!=', Number(pullRequest.id))
      .executeTakeFirst()

    let deletedBranch = false
    const mayDelete = head !== '' && mayDeleteHeadBranch({
      deleteOnMerge: Boolean((repository as any).delete_branch_on_merge),
      headIsDefaultBranch: head === String(repository.default_branch) || head === String(pullRequest.base_branch),
      // Cross-repository pull requests are not modelled yet, so a head is
      // always in this repository. Named rather than assumed, so the day forks
      // arrive this reads as a thing to revisit rather than as a silent bug.
      headIsFork: false,
      openPullRequestsOnHead: Number(stillOnHead?.count ?? 0),
    })

    if (mayDelete) {
      const removed = await runGit(resolved.path!, ['update-ref', '-d', `refs/heads/${head}`])
      deletedBranch = removed.ok
    }

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
      // A child adopting the merged parent's base also adopts the sha the
      // base now points at. The row's base_sha is what the eventual merge
      // guards its update-ref on; left at the parent's old head, every merge
      // of a retargeted child would be refused as "the base moved" - because
      // it had, at retarget time, and nothing had said so.
      const adoptedBase = move.baseBranch === String(pullRequest.base_branch)

      await db
        .updateTable('pull_requests')
        .set({
          base_branch: move.baseBranch,
          stack_parent_id: move.stackParentId,
          ...(adoptedBase ? { base_sha: merged.sha, mergeable_state: 'unknown' } : {}),
        })
        .where('id', '=', move.id)
        .execute()
    }

    // Retargeting moved the children's bases; restacking moves their
    // branches, so a child of a squashed parent stops showing the parent's
    // work in its own diff. Only the children the retarget itself moved -
    // one somebody pointed elsewhere by hand keeps their branch untouched -
    // and a conflict or a race leaves the branch alone. Each rebased child
    // gets its row brought current and an auto-merge attempt, which is what
    // makes an armed stack land in order: the layer above becomes ready the
    // moment the layer below lands. Never fails the merge that already
    // happened.
    const restacked: Array<{ id: number, outcome: string }> = []
    try {
      const { restackChild } = await import('./restack')
      const { attemptAutoMerge } = await import('./autoMerge')
      const retargeted = new Set(
        moves.filter(move => move.baseBranch === String(pullRequest.base_branch)).map(move => move.id),
      )

      for (const child of children) {
        if (!retargeted.has(Number(child.id)))
          continue

        const row: any = await db
          .selectFrom('pull_requests')
          .select(['id', 'head_branch', 'head_sha'])
          .where('id', '=', Number(child.id))
          .executeTakeFirst()

        if (!row)
          continue

        const outcome = await restackChild({
          diskPath: resolved.path!,
          child: { id: Number(row.id), headBranch: String(row.head_branch), headSha: String(row.head_sha) },
          parentOldHead: String(pullRequest.head_sha),
          baseBranch: String(pullRequest.base_branch),
        })

        restacked.push({ id: outcome.pullRequestId, outcome: outcome.outcome })

        if (outcome.outcome === 'rebased' && outcome.newHead) {
          await db
            .updateTable('pull_requests')
            .set({ head_sha: outcome.newHead, mergeable_state: 'unknown' })
            .where('id', '=', Number(row.id))
            .execute()

          await attemptAutoMerge(Number(row.id))
        }
      }
    }
    catch {
      // The merge landed; a child left unrestacked is the pre-restack world,
      // which every stack survived until now.
    }

    // Issues the description says this closes. Done after the merge landed,
    // never before: closing an issue for a merge that then failed leaves
    // somebody's report shut with nothing to show for it.
    const closed = await closeReferenced(
      String(pullRequest.body ?? ''),
      { owner: String(request.get('owner')), repository: String(repository.name) },
      Number(repository.id),
      number,
      Number(user.id),
    )

    return response.json({
      number,
      state: 'merged',
      strategy,
      merge_commit_sha: merged.sha,
      retargeted: moves.map(move => move.id),
      restacked,
      deleted_branch: deletedBranch,
      closed,
    })
  },
})

/** Commit subjects on the head that are not on the base, oldest first. */
async function subjectsOnBranch(path: string, baseSha: string, headSha: string): Promise<string[]> {
  const result = await runGit(path, ['log', '--reverse', '--format=%s', `${baseSha}..${headSha}`])

  return result.ok ? result.stdout.split('\n').filter(Boolean) : []
}

/**
 * Close the issues a merged pull request said it would.
 *
 * Only issues that are open, and only issues: the numbering is shared with
 * pull requests, so `fixes #12` where 12 is a pull request would otherwise
 * close it as though it were a report.
 *
 * Failures here are not merge failures. The branch has already landed, and
 * answering the merge with an error because a follow-up write failed tells the
 * caller the wrong thing about the thing they asked for.
 */
async function closeReferenced(
  body: string,
  scope: { owner: string, repository: string },
  repositoryId: number,
  selfNumber: number,
  actorId: number,
): Promise<number[]> {
  const targets = withoutSelf(closingTargets(body, scope), selfNumber)
  if (targets.length === 0)
    return []

  try {
    const open: any[] = await db
      .selectFrom('issues')
      .select(['id', 'number'])
      .where('repository_id', '=', repositoryId)
      .where('number', 'in', targets.map(target => target.number))
      .where('is_pull_request', '=', false)
      .where('state', '=', 'open')
      .execute()

    if (open.length === 0)
      return []

    // Through `updateWhereIn` rather than the query builder's own `in`, which
    // renders `WHERE "id" in $1` on an update and fails - so merging a pull
    // request had never closed anything it said it closed. See
    // `app/Actions/Support/rows.ts`.
    await updateWhereIn('issues', 'id', open.map(row => Number(row.id)), {
      state: 'closed',
      state_reason: 'completed',
      closed_at: new Date().toISOString(),
      closed_by_id: actorId,
    })

    await recountOpenIssues(repositoryId)

    return open.map(row => Number(row.number))
  }
  catch {
    return []
  }
}
