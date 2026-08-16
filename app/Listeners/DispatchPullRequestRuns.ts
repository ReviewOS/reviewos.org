import { db } from '@stacksjs/database'
import { changedPaths } from '../Actions/Workflow/changed'
import { dispatchPullRequest } from '../Actions/Workflow/dispatch'

/**
 * Start the runs a pull request asks for.
 *
 * `on: pull_request` is the trigger this product exists around - CI on the
 * change somebody is reviewing - and it was stored on every version and read by
 * nothing. A workflow that named it never ran, which for a forge built around
 * review is the wrong trigger to be missing.
 *
 * **The definition comes from the base branch, never from the head.** That is
 * enforced in `dispatchPullRequest`, which reads the versions the repository
 * has registered rather than parsing anything from the pull request - see the
 * fork policy in [the threat model](../../docs/ci-threat-model.md). This
 * listener supplies the event; it does not supply a workflow.
 *
 * Fire-and-forget, like every listener here: a pull request is answered when
 * the row is written, not when CI has been thought about.
 */
export default {
  listensTo: ['pr:opened', 'pr:synchronized', 'pr:ready_for_review'],

  async handle(payload: any, eventName?: string): Promise<void> {
    /*
     * Both forms accepted, for the reason `DispatchWebhooks` gives: the two
     * event libraries in play disagree about whether a handler is told which
     * event fired, and guessing wrong would type every pull request event as
     * `opened` - which starts a run on a push to a branch, from a workflow that
     * only asked for `opened`.
     */
    await handleEvent(payload, String(payload?.event ?? eventName ?? ''))
  },
}

/** The work, separated from the listener shape so a test can call it directly. */
export async function handleEvent(event: any, eventName = ''): Promise<void> {
  try {
    const repositoryId = Number(event?.repositoryId ?? 0)
    const number = Number(event?.number ?? 0)

    if (!repositoryId || !number)
      return

    const pullRequest: any = await db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'head_sha', 'base_branch', 'head_branch', 'head_repository_id', 'repository_id', 'draft', 'state'])
      .where('repository_id', '=', repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return

    // A closed pull request has nothing to test. `closed` is an activity type a
    // workflow can ask for, and the event for it is not this one.
    if (String(pullRequest.state ?? '') !== 'open')
      return

    const headSha = String(pullRequest.head_sha ?? '')

    if (!headSha)
      return

    /*
     * A head repository that is not this one is a fork, and a fork's run is
     * untrusted for its whole life. The column is the only thing that decides
     * it - not the branch name, not who pushed - because that is the fact the
     * threat model turns on.
     */
    const headRepositoryId = Number(pullRequest.head_repository_id ?? repositoryId)
    const fromFork = headRepositoryId !== repositoryId

    const name = eventName || String(event?.event ?? '')

    const activity = name === 'pr:synchronized'
      ? 'synchronize'
      : name === 'pr:ready_for_review'
        ? 'ready_for_review'
        : 'opened'

    await dispatchPullRequest({
      repositoryId,
      headSha,
      ref: `refs/pull/${number}/head`,
      number,
      actorId: Number(event?.actorId ?? 0) || null,
      event: {
        activity,
        baseBranch: String(pullRequest.base_branch ?? ''),
        headBranch: String(pullRequest.head_branch ?? ''),
        fromFork,
        draft: Boolean(pullRequest.draft),
        // What the pull request changes, for `paths:` and `paths-ignore:`.
        // Empty is "unknown", which errs towards running.
        changed: await changedPathsFor(repositoryId, event, pullRequest, headSha),
      },
    })
  }
  catch {
    /*
     * A listener must never be able to fail the thing that emitted it. By the
     * time this runs the pull request exists and has been answered; the worst
     * case here is a run that did not start, which the run list shows as
     * nothing rather than as a broken pull request.
     */
  }
}

/**
 * The files this pull request changes, against its base.
 *
 * Diffed from the base branch's tip rather than from the merge base, which is
 * the cheaper of the two and the one that matches what a reviewer sees on the
 * diff screen. A repository whose git directory cannot be resolved answers with
 * nothing, which reads as "unknown" and errs towards running.
 */
async function changedPathsFor(
  repositoryId: number,
  event: any,
  pullRequest: any,
  headSha: string,
): Promise<string[]> {
  try {
    const { repositoryPath } = await import('../Actions/Git/storage')

    const repository: any = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    const owner = String(event?.owner ?? '')

    if (!repository || !owner)
      return []

    const resolved = repositoryPath(owner, String(repository.name))

    if (!resolved.ok || !resolved.path)
      return []

    const base = String(pullRequest.base_branch ?? '')

    return await changedPaths(resolved.path, base, headSha)
  }
  catch {
    return []
  }
}
