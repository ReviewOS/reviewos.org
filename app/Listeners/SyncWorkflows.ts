import { db } from '@stacksjs/database'
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
 * **Only the default branch.** The workflow definition comes from the trusted
 * ref - that is the fork rule in [the threat
 * model](../../docs/ci-threat-model.md) - and syncing from whatever branch
 * happened to move would let anybody with push access to any branch replace the
 * definitions the instance holds. A push to a feature branch may still *start*
 * a run later, but the workflow it runs is the one on the default branch.
 *
 * Nothing here starts anything. Registering a definition is not scheduling
 * work, and the run models this would dispatch into do not exist yet - so the
 * honest behaviour is to keep the definitions current and stop, rather than to
 * half-implement dispatch where a missing run is invisible.
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
  }
  catch {
    // An event is a consequence of somebody's push and must never be able to
    // fail it. By the time this runs the refs have moved and the push has been
    // answered; the worst case here is definitions that are one push stale.
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
