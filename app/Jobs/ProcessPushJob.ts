import type { RefUpdate } from '../Actions/Git/push'
import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { isFullSha, isSafeRevision, listBranches, runGit } from '../Actions/Git/git'
import { repositoryByGitDir } from '../Actions/Git/hooks'
import { adoptedDefaultBranch, branchUpdates, commitRange } from '../Actions/Git/push'
import { recountOpenIssues } from '../Actions/Repo/counters'
import { recordSize } from '../Actions/Repo/size'
import { recordCommitReferences } from '../Actions/Issue/crossReferences'
import { closingTargets } from '../Actions/Issue/closing'
import { record } from '../Actions/Issue/timeline'
import { notifyProgramsOnly } from '../Notifications/emit'

/**
 * Everything that happens because somebody pushed.
 *
 * Queued, not inline. The hook runs inside `git push`, and the pusher is
 * standing at a prompt: walking the commits of a large push, reading their
 * messages, and updating every pull request that points at the branch takes
 * longer than anybody should wait to be told their push landed. The push has
 * already landed - git accepted it before the hook ran - so none of this is on
 * the critical path of anything.
 *
 * Nothing here fails the push either, because there is no push left to fail.
 * Each step is independent and each one swallows its own errors: a repository
 * whose `pushed_at` did not update should still have its issues closed.
 */
export default new Job({
  name: 'ProcessPush',
  description: 'Record a push: the ref updates, the commits, and what they say',
  queue: 'git',
  tries: 3,
  backoff: 15,

  async handle(payload: { gitDir: string, updates: RefUpdate[] }) {
    const gitDir = String(payload?.gitDir ?? '')
    const updates = Array.isArray(payload?.updates) ? payload.updates : []

    if (!gitDir || updates.length === 0)
      return { ok: false, reason: 'nothing to process' }

    // Resolved from the path on disk, never from a name in the request. The
    // hook says which directory it ran in; what that directory *is* remains the
    // application's question to answer.
    const repository: any = await repositoryByGitDir(gitDir)
    if (!repository)
      return { ok: false, reason: 'no repository at that path' }

    const owner = await ownerHandleOf(repository)
    const branches = branchUpdates(updates)

    await touchPushedAt(Number(repository.id))
    // After the objects have landed, so what is measured is what the push left.
    const sizeKb = await recordSize(Number(repository.id), gitDir)
    const defaultBranch = await settleDefaultBranch(repository, updates, gitDir)
    const refreshed = await refreshPullRequests(Number(repository.id), branches, {
      owner: owner ?? '',
      name: String(repository.name ?? ''),
    })
    // After the head shas are current, so the recompute reads what this push
    // left rather than what the last one did.
    const precomputed = owner ? await precomputeMergeability(repository, owner, branches) : 0

    // A push can be the last requirement: the conflict fixed on a head, or a
    // base moving under a pull request whose rules just became satisfiable.
    // Does nothing unless somebody armed auto-merge, and never throws.
    const { attemptAutoMergeOnBranches } = await import('../Actions/Pull/autoMerge')
    const autoMerged = await attemptAutoMergeOnBranches(
      Number(repository.id),
      branches.filter(update => update.change !== 'deleted').map(update => update.name),
    )
    const commits = await collectCommits(gitDir, branches)
    const closed = owner ? await actOnCommitMessages(repository, owner, commits) : []

    // Emitted last, so a listener that reads the repository sees it as this
    // push left it rather than as it was halfway through. A listener that
    // throws is a listener's problem: the push happened either way, and the
    // job's own result is what the queue retries on.
    try {
      dispatch('push:received', {
        repositoryId: Number(repository.id),
        owner,
        repository: String(repository.name),
        defaultBranch,
        updates,
        commits: commits.length,
        closedIssues: closed,
        pullRequestsRefreshed: refreshed,
      })
    }
    catch {
      // Deliberately silent.
    }

    return {
      ok: true,
      refs: updates.length,
      commits: commits.length,
      closedIssues: closed,
      pullRequestsRefreshed: refreshed,
      mergeabilityPrecomputed: precomputed,
      autoMerged,
      sizeKb,
    }
  },
})

/** The owner's handle, for the references that need to know where they are. */
async function ownerHandleOf(repository: any): Promise<string | null> {
  const table = repository.owner_type === 'organization' ? 'organizations' : 'users'

  const row = await db
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()

  return row?.handle ? String(row.handle) : null
}

async function touchPushedAt(repositoryId: number): Promise<void> {
  try {
    await db
      .updateTable('repositories')
      .set({ pushed_at: new Date().toISOString() })
      .where('id', '=', repositoryId)
      .execute()
  }
  catch {
    // A stale `pushed_at` is a sorting inaccuracy on a list. It is not worth
    // failing the rest of the work for.
    return
  }

  /*
   * And tell the index, because nothing else will.
   *
   * The `useSearch` trait re-indexes on save, which covers a repository being
   * renamed or having its description edited - those go through the model. A
   * push does not: the update above is deliberately raw SQL, so no model hook
   * fires, and `pushed_at` is exactly the field the search results sort by.
   * Without this the index keeps whatever timestamp it was built with and
   * "recently active" means "recently reindexed", which is a ranking that
   * quietly stops tracking reality.
   */
  await reindex(repositoryId)
}

/**
 * Queue a reindex, and never let it fail the push.
 *
 * The search node being down is not a reason to fail work that has already
 * been written to disk and to the database. The index is allowed to lag - the
 * code that reads it re-checks every hit against the database anyway - so this
 * is dispatched and forgotten.
 */
async function reindex(repositoryId: number): Promise<void> {
  try {
    const IndexRepositoryJob = (await import('./IndexRepositoryJob')).default

    await IndexRepositoryJob.dispatch({ repositoryId })
  }
  catch (error) {
    console.error('[push] could not queue a reindex:', error)
  }

  /*
   * And a re-measure of what the repository is written in.
   *
   * Here rather than on a schedule, because a language breakdown is only wrong
   * in one direction - a repository that has just changed - and the push is
   * exactly when that happened. Separately caught, so a failure to queue one
   * does not stop the other: they are two independent conveniences and neither
   * is worth failing a push that is already written to disk.
   */
  try {
    const MeasureLanguagesJob = (await import('./MeasureLanguagesJob')).default

    await MeasureLanguagesJob.dispatch({ repositoryId })
  }
  catch (error) {
    console.error('[push] could not queue a language measurement:', error)
  }

  /*
   * And the code index, on the same queue and with the same reasoning.
   *
   * Failing to queue it is logged rather than raised: the index is a filter
   * over what to search, never the answer, so a repository whose shard is
   * missing or behind is searched more slowly rather than searched wrongly.
   * Making a push fail because an index could not be queued would trade a
   * correctness-free property for the one thing a forge must not get wrong.
   */
  try {
    const IndexCodeJob = (await import('./IndexCodeJob')).default

    await IndexCodeJob.dispatch({ repositoryId })
  }
  catch (error) {
    console.error('[push] could not queue a code index build:', error)
  }

  /*
   * And a re-measure of who wrote it, for the same reason and with the same
   * separate catch: a push is the only thing that changes the answer, and
   * walking the history is precisely the work no page can do.
   */
  try {
    const MeasureContributorsJob = (await import('./MeasureContributorsJob')).default

    await MeasureContributorsJob.dispatch({ repositoryId })
  }
  catch (error) {
    console.error('[push] could not queue a contributor measurement:', error)
  }
}

/**
 * Keep the default branch pointing at something that exists.
 *
 * Only ever adopts on the first push into an empty repository, where the row
 * says `main` and the pusher pushed `master`. A push that could repoint the
 * default branch at any other time would be a push that can change what
 * everybody sees when they open the repository, which is not a thing a push
 * should be able to do quietly.
 */
async function settleDefaultBranch(repository: any, updates: RefUpdate[], gitDir: string): Promise<string> {
  const current = String(repository.default_branch ?? 'main')

  try {
    const existing = await listBranches(gitDir)
    const adopted = adoptedDefaultBranch(updates, current, existing)

    if (!adopted)
      return current

    await db
      .updateTable('repositories')
      .set({ default_branch: adopted })
      .where('id', '=', Number(repository.id))
      .execute()

    // HEAD as well, or a clone checks out nothing and every `git clone` of this
    // repository prints a warning about an unborn branch.
    await runGit(gitDir, ['symbolic-ref', 'HEAD', `refs/heads/${adopted}`])

    return adopted
  }
  catch {
    return current
  }
}

/**
 * Mark the open pull requests whose head branch just moved.
 *
 * The mergeability answer is recomputed elsewhere, on demand and in a job of
 * its own, because it needs a merge simulation. What happens here is the cheap
 * half: the recorded head sha is brought up to date and the mergeable state is
 * marked unknown, so nothing shows a stale "no conflicts" against a branch that
 * has moved since it was computed. A wrong green is worse than a missing one.
 */
async function refreshPullRequests(
  repositoryId: number,
  branches: RefUpdate[],
  repository?: { owner: string, name: string },
): Promise<number> {
  let refreshed = 0

  for (const update of branches) {
    if (update.change === 'deleted')
      continue

    try {
      /*
       * Read before the write, because the event needs to name which pull
       * requests moved and an `UPDATE` reports a count rather than rows. One
       * extra query per pushed branch, on a path that already spawns git.
       */
      const affected = await db
        .selectFrom('pull_requests')
        .select(['id', 'number', 'title', 'author_id', 'head_sha'])
        .where('repository_id', '=', repositoryId)
        .where('head_branch', '=', update.name)
        .where('state', '=', 'open')
        .execute()

      const result = await db
        .updateTable('pull_requests')
        .set({ head_sha: update.after, mergeable_state: 'unknown' })
        .where('repository_id', '=', repositoryId)
        .where('head_branch', '=', update.name)
        .where('state', '=', 'open')
        .executeTakeFirst()

      refreshed += Number(result?.numUpdatedRows ?? 0)

      /*
       * `pr:synchronized`, the event a reviewing agent most needs.
       *
       * Emitted after the row is updated, so a receiver that immediately reads
       * the pull request back sees the new head rather than the one it was
       * told about. The other order is a race that only shows up under load
       * and reads as the API lying.
       *
       * Only when the sha genuinely changed: a push that leaves a branch where
       * it was - a re-push of the same commits, a tag alongside - is not a
       * change anybody needs telling about.
       */
      for (const pullRequest of affected) {
        if (String(pullRequest.head_sha ?? '') === String(update.after))
          continue

        await notifyProgramsOnly('pr:synchronized', {
          // The push, not a person clicking. `actorId` is the pusher where the
          // job knows one; zero reads as "the system" to every consumer.
          actorId: 0,
          actorHandle: '',
          repositoryId,
          owner: repository?.owner ?? '',
          repository: repository?.name ?? '',
          subjectType: 'pull_request',
          subjectId: Number(pullRequest.id),
          number: Number(pullRequest.number),
          title: String(pullRequest.title ?? ''),
          detail: String(update.after),
        })
      }
    }
    catch {
      // Same rule as everywhere else in this job: one branch failing does not
      // cost the others their processing.
    }
  }

  return refreshed
}

/**
 * Compute mergeability now, so the first visitor after this push does not.
 *
 * The view already computes and caches this on demand; what moves here is only
 * *when* the cost is paid. The push is the moment the cached answer went
 * stale, nobody is waiting on this job, and the cache keys on the two shas -
 * so the page's own call finds the answer current and renders instantly. A
 * failure here costs nothing but that head start: the view recomputes on
 * demand exactly as before.
 */
async function precomputeMergeability(repository: any, owner: string, branches: RefUpdate[]): Promise<number> {
  const moved = branches
    .filter(update => update.change !== 'deleted')
    .map(update => update.name)

  if (moved.length === 0)
    return 0

  let computed = 0

  for (const branch of moved) {
    try {
      const rows = await db
        .selectFrom('pull_requests')
        .select(['id', 'base_sha', 'head_sha', 'mergeable_state', 'mergeable_base_sha', 'mergeable_head_sha', 'mergeable_conflicts'])
        .where('repository_id', '=', Number(repository.id))
        .where('head_branch', '=', branch)
        .where('state', '=', 'open')
        .execute()

      for (const row of rows) {
        const { refreshMergeability } = await import('../Actions/Pull/refresh-mergeability')

        const answer = await refreshMergeability(owner, String(repository.name), {
          id: Number(row.id),
          base_sha: String(row.base_sha),
          head_sha: String(row.head_sha),
          mergeable_state: row.mergeable_state,
          mergeable_base_sha: row.mergeable_base_sha,
          mergeable_head_sha: row.mergeable_head_sha,
          mergeable_conflicts: row.mergeable_conflicts,
        })

        if (answer.recomputed)
          computed += 1
      }
    }
    catch {
      // Same rule as everywhere else in this job: one branch failing does not
      // cost the others their processing, and the view recomputes on demand.
    }
  }

  return computed
}

export interface PushedCommit {
  sha: string
  message: string
}

/**
 * How many commits one push is read for.
 *
 * A push of ten thousand commits is a repository being imported, not somebody
 * describing what they fixed, and reading every message to look for `fixes #12`
 * would spend minutes to find nothing. The newest are the ones that carry
 * intent.
 */
export const COMMIT_SCAN_LIMIT = 500

/**
 * The commit messages a push introduced.
 *
 * A created branch has no lower bound, and walking it from the tip would re-read
 * the entire history of the project on the first push of a fork. So it is
 * bounded by every *other* ref: the commits reachable from the new branch and
 * from nothing else are the ones this push introduced.
 *
 * `--not --all` is the obvious way to write that and is wrong here. This runs
 * from `post-receive`, so by the time it asks, the new ref already exists and
 * `--all` includes it - the branch excludes itself and the answer is always
 * empty. It cost a push that closed nothing and reported success. The other
 * refs are enumerated instead, and fed on stdin so a repository with thousands
 * of them does not build a command line out of them.
 *
 * Deduplicated across refs, because pushing two branches that share commits is
 * ordinary and acting on one message twice is not.
 */
async function collectCommits(gitDir: string, branches: RefUpdate[]): Promise<PushedCommit[]> {
  const seen = new Map<string, string>()

  for (const update of branches) {
    const range = commitRange(update)
    if (!range)
      continue

    if (!isFullSha(range.to) || (range.from !== null && !isFullSha(range.from)))
      continue

    // NUL-delimited, because a commit message contains newlines and blank
    // lines by design, and any line-oriented parse of one is wrong on the
    // first commit that has a body.
    const args = ['log', `--max-count=${COMMIT_SCAN_LIMIT}`, '--format=%H%x00%B%x00']
    let input: string | undefined

    if (range.from === null) {
      args.push('--stdin')
      input = [range.to, ...(await otherRefs(gitDir, update.ref)).map(ref => `^${ref}`)].join('\n')
    }
    else {
      args.push(`${range.from}..${range.to}`)
    }

    const result = await runGit(gitDir, args, { timeoutMs: 60_000, input })
    if (!result.ok)
      continue

    for (const [sha, message] of parseLog(result.stdout)) {
      if (!seen.has(sha))
        seen.set(sha, message)
    }
  }

  return [...seen].map(([sha, message]) => ({ sha, message }))
}

/** Every ref except the one being processed, to bound a newly created branch. */
async function otherRefs(gitDir: string, exclude: string): Promise<string[]> {
  const result = await runGit(gitDir, ['for-each-ref', '--format=%(refname)'])
  if (!result.ok)
    return []

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(ref => ref.length > 0 && ref !== exclude)
}

/** `<sha>NUL<message>NUL` repeated. Exported so the parsing can be tested. */
export function parseLog(stdout: string): Array<[string, string]> {
  const fields = stdout.split('\0')
  const commits: Array<[string, string]> = []

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i]!.trim()
    if (isFullSha(sha))
      commits.push([sha, fields[i + 1]!])
  }

  return commits
}

/**
 * What the commit messages say to do.
 *
 * Two things, and they are the two boxes phase 3 could not tick without this
 * job existing:
 *
 * - **Closing keywords.** `fixes #12` in a pushed commit closes issue 12, on
 *   the same terms a merged pull request closes one: this repository only, and
 *   issues only.
 * - **Cross references.** `#12` in a commit message records an entry on issue
 *   12, so somebody reading it can see the commit that was about it.
 *
 * The actor is not known. A commit has an author and a committer, both of them
 * free-text email addresses that anybody can set to anything, so attributing a
 * timeline entry to a local account on the strength of one would be putting
 * words in somebody's mouth. The entry is recorded with no actor, which reads
 * as the repository having done it - which is what happened.
 */
async function actOnCommitMessages(
  repository: any,
  owner: string,
  commits: PushedCommit[],
): Promise<number[]> {
  if (commits.length === 0)
    return []

  const scope = { owner, repository: String(repository.name) }
  const closed: number[] = []

  for (const commit of commits) {
    if (!isSafeRevision(commit.sha))
      continue

    await recordCommitReferences(Number(repository.id), commit.sha, commit.message)

    for (const target of closingTargets(commit.message, scope)) {
      const done = await closeIssue(Number(repository.id), target.number, commit.sha)
      if (done)
        closed.push(target.number)
    }
  }

  return [...new Set(closed)]
}

/**
 * Close one issue because a pushed commit said to.
 *
 * Only an issue, and only an open one. A pull request carrying the same number
 * is left alone: the numbering is shared, and `fixes #7` in a commit on the
 * branch of pull request 7 would otherwise close the pull request as though the
 * push had merged it.
 */
async function closeIssue(repositoryId: number, number: number, sha: string): Promise<boolean> {
  try {
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'state'])
      .where('repository_id', '=', repositoryId)
      .where('number', '=', number)
      .where('is_pull_request', '=', false)
      .executeTakeFirst()

    if (!issue || String(issue.state) !== 'open')
      return false

    await db
      .updateTable('issues')
      .set({
        state: 'closed',
        state_reason: 'completed',
        closed_at: new Date().toISOString(),
      })
      .where('id', '=', Number(issue.id))
      .execute()

    await recountOpenIssues(repositoryId)

    // No actor: a commit's author is free text that anybody can set, so the
    // close is recorded as having happened rather than as somebody's doing.
    await record({ type: 'issue', id: Number(issue.id) }, 'closed', null, { text: sha.slice(0, 7) })

    return true
  }
  catch {
    return false
  }
}
