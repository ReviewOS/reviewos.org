import { db } from '@stacksjs/database'
import { changedPaths, commitMessage } from '../Actions/Workflow/changed'
import { discoverWorkflows } from '../Actions/Workflow/discover'
import { syncWorkflowFile } from '../Actions/Workflow/sync'

/**
 * Register a repository's workflows when its default branch moves.
 *
 * A fourth listener on `push:received`, beside the ones that notify, deliver
 * webhooks and record activity, and separate for the reason they are separate
 * from each other: it answers a different question and fails differently. This
 * one reads a tree and writes definitions; a failure here must not cost a
 * notification.
 *
 * **Definitions come from the default branch only.** That is the fork rule in
 * [the threat model](../../docs/ci-threat-model.md): syncing from whatever
 * branch happened to move would let anybody with push access to any branch
 * replace the definitions the instance holds.
 *
 * **Runs are created for every branch that moved.** A push to a feature branch
 * is a push somebody expects CI on, and only running the default branch would
 * make the feature look broken to anybody working the way people actually work.
 * The two rules are different on purpose: where the workflow comes from is a
 * trust question, and which pushes it responds to is not.
 *
 * Creating a run is still not executing one. The jobs land in `blocked` or
 * `queued` and wait for an execution plane, which by the threat model is not
 * this instance unless an operator has provided one.
 */
export default {
  listensTo: ['push:received'],

  async handle(event: any): Promise<void> {
    await syncFromPush(event)
  },
}

/**
 * The work, separated from the listener shape so a test can call it directly.
 *
 * The shape matters and is easy to get wrong: discovery scans `app/Listeners`
 * for a default export of `{ listensTo, handle }` and *skips* anything else
 * with a line in the log nobody reads. A bare exported function registers
 * nothing and fails exactly like a listener that is wired and does nothing.
 */
export async function syncFromPush(event: any): Promise<void> {
  try {
    const repositoryId = Number(event?.repositoryId)
    const defaultBranch = String(event?.defaultBranch ?? '')
    if (!Number.isFinite(repositoryId) || !defaultBranch)
      return

    const updates = Array.isArray(event?.updates) ? event.updates : []

    // The default branch's new head, or nothing to do. A push that did not move
    // it cannot have changed the definitions this instance trusts.
    const moved = updates.find((update: any) =>
      update?.kind === 'branch'
      && update?.name === defaultBranch
      && update?.change !== 'deleted')

    if (!moved?.after)
      return

    const repository: any = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'disk_path', 'owner_type', 'owner_id'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository)
      return

    const gitDir = await resolveGitDir(repository, String(event?.owner ?? ''))
    if (!gitDir)
      return

    const found = await discoverWorkflows(gitDir, String(moved.after))

    for (const file of found) {
      // One bad file does not stop the others. A repository with four workflows
      // and one typo should end up with three registered and one reported,
      // rather than none - the alternative makes a single mistake look like the
      // whole feature is broken.
      await syncWorkflowFile({
        repositoryId: Number(repository.id),
        ownerType: String(repository.owner_type) === 'organization' ? 'organization' : 'user',
        ownerId: Number(repository.owner_id),
        path: file.path,
        source: file.source,
        sha: String(moved.after),
      }).catch(() => null)
    }

    /*
     * A file that is no longer there stops running.
     *
     * Deleting a workflow used to leave its row active forever, so a repository
     * that removed its CI kept starting runs from a definition nobody could
     * find in the tree. The same applies when a repository copies its
     * workflows to `.reviewos/workflows` - the `.github` ones stop being read,
     * and a row that still says `active` would be a workflow with no file.
     *
     * `removed` rather than `disabled`: a person's decision to switch a
     * workflow off has to survive the file coming back, and one state for both
     * would let a revert quietly resurrect it.
     */
    await retireMissing(Number(repository.id), found.map(file => file.path))

    // Definitions first, then what they say to do with this push - in that
    // order, so a workflow added by this very push can run on it. The other
    // order is the one where adding CI to a repository does nothing until the
    // next commit, which reads as CI being broken.
    await dispatchForPush(repository, event)
  }
  catch {
    // An event is a consequence of somebody's push and must never be able to
    // fail it. By the time this runs the refs have moved and the push has been
    // answered; the worst case here is definitions that are one push stale.
  }
}

/**
 * Mark every active workflow of this repository whose file is gone.
 *
 * Only rows that are `active`: a workflow somebody switched off stays off, and
 * one already marked `removed` needs no second write.
 */
async function retireMissing(repositoryId: number, present: string[]): Promise<void> {
  const active: any[] = await db
    .selectFrom('workflows')
    .select(['id', 'path'])
    .where('repository_id', '=', repositoryId)
    .where('state', '=', 'active')
    .execute()

  const gone = active.filter(workflow => !present.includes(String(workflow.path)))

  for (const workflow of gone) {
    await db
      .updateTable('workflows')
      .set({ state: 'removed' })
      .where('id', '=', Number(workflow.id))
      .execute()
      .catch(() => null)
  }
}

/**
 * Where this repository is on disk.
 *
 * `repositories.disk_path` is not one thing. Different writers have stored
 * different shapes in it - `mirror:add` records an absolute path, while the
 * checkout path used elsewhere records one relative to the repository root -
 * so reading the column and handing it to git works for some repositories and
 * silently finds nothing for others. Silently, because a missing directory is
 * how git reports "this commit has no `.github/workflows`", which is also the
 * ordinary answer for most repositories.
 *
 * So the owner and name are the source of truth, the way the diff actions
 * already treat them, and the column is a fallback for the absolute case.
 */
async function resolveGitDir(repository: any, owner: string): Promise<string | null> {
  const { diskPathFor } = await import('../Actions/Git/access')

  const handle = owner || await ownerHandle(repository)
  const resolved = handle ? diskPathFor(handle, String(repository.name ?? '')) : null
  if (resolved)
    return resolved

  const stored = String(repository.disk_path ?? '')
  return stored.startsWith('/') ? stored : null
}

/** The owner's handle, when the event did not carry it. */
async function ownerHandle(repository: any): Promise<string> {
  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'

  const row: any = await db
    .selectFrom(table as any)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()

  return String(row?.handle ?? '')
}

/**
 * Start the runs this push should start.
 *
 * Every branch that moved, not only the default one. The *definitions* come
 * from the default branch - that is the fork rule - but a push to a feature
 * branch is a push somebody expects CI on, and only running the default branch
 * would make the whole feature look broken to anybody working the way people
 * actually work.
 */
async function dispatchForPush(repository: any, event: any): Promise<void> {
  const { dispatchPush } = await import('../Actions/Workflow/dispatch')

  const updates = Array.isArray(event?.updates) ? event.updates : []

  const branches = updates.filter((update: any) =>
    update?.kind === 'branch' && update?.change !== 'deleted' && update?.after)

  // A tag push is a push too, and a workflow can ask for tags.
  const tags = updates.filter((update: any) =>
    update?.kind === 'tag' && update?.change !== 'deleted' && update?.after)

  // The same resolution the definitions used, and for the same reason: the
  // column is not one shape across writers, so the owner and name decide.
  const gitDir = await resolveGitDir(repository, String(event?.owner ?? ''))

  for (const update of [...branches, ...tags]) {
    /*
     * What the push changed, which is what `paths:` and `paths-ignore:` need.
     *
     * This used to be an empty list with a comment saying the paths were not
     * known here, so both filters did nothing: a documentation-only push
     * started the whole test suite, which is the one thing `paths-ignore`
     * exists to prevent. One `git diff --name-only` per updated ref answers it.
     *
     * Empty still means "unknown", and `pushStartsRun` still errs towards
     * running on it - a missed run is a broken product and an extra run is a
     * wasted minute.
     */
    const changed = gitDir
      ? await changedPaths(gitDir, String(update.before ?? ''), String(update.after)).catch(() => [])
      : []

    /*
     * The message, for a job's `if:`. Read here rather than at dispatch, which
     * has no repository directory - and empty when it cannot be read, the same
     * convention the changed paths follow.
     */
    const message = gitDir && update.change !== 'deleted'
      ? await commitMessage(gitDir, String(update.after)).catch(() => '')
      : ''

    await dispatchPush({
      repositoryId: Number(repository.id),
      headSha: String(update.after),
      event: {
        ref: String(update.ref),
        changed,
        message,
        deleted: update.change === 'deleted',
      },
    }).catch(() => null)
  }

}
