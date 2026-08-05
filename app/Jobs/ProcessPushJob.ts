import type { RefUpdate } from '../Actions/Git/push'
import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { isFullSha, isSafeRevision, listBranches, runGit } from '../Actions/Git/git'
import { repositoryByGitDir } from '../Actions/Git/hooks'
import { adoptedDefaultBranch, branchUpdates, commitRange } from '../Actions/Git/push'
import { recountOpenIssues } from '../Actions/Repo/counters'
import { recordCommitReferences } from '../Actions/Issue/crossReferences'
import { closingTargets } from '../Actions/Issue/closing'
import { record } from '../Actions/Issue/timeline'

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
    const defaultBranch = await settleDefaultBranch(repository, updates, gitDir)
    const refreshed = await refreshPullRequests(Number(repository.id), branches)
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
async function refreshPullRequests(repositoryId: number, branches: RefUpdate[]): Promise<number> {
  let refreshed = 0

  for (const update of branches) {
    if (update.change === 'deleted')
      continue

    try {
      const result = await db
        .updateTable('pull_requests')
        .set({ head_sha: update.after, mergeable_state: 'unknown' })
        .where('repository_id', '=', repositoryId)
        .where('head_branch', '=', update.name)
        .where('state', '=', 'open')
        .executeTakeFirst()

      refreshed += Number(result?.numUpdatedRows ?? 0)
    }
    catch {
      // Same rule as everywhere else in this job: one branch failing does not
      // cost the others their processing.
    }
  }

  return refreshed
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
    const issue: any = await db
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
