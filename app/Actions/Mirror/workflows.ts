/**
 * A mirror's sync, run as the push it stands for.
 *
 * A mirror never goes through `ProcessPushJob` - its refs move by `git fetch`,
 * not by somebody pushing - so nothing listening on `push:received` ever heard
 * about it, and a mirror's workflows were never registered, let alone run. For
 * most mirrors that is right: they are copies of other people's projects, and
 * running their CI here would spend this instance's runners on work nobody
 * asked for. For a mirror whose owners do want it (`run_workflows`, see
 * `RepositoryMirror`), this is the bridge: the ref changes a sync found, in the
 * shape a push delivers, handed to the same listener a push reaches. One path,
 * so the trust rule, the `paths` filters and the run numbering are the push's
 * own rather than a second copy that drifts from it.
 */

import type { RefKind, RefUpdate } from '../Git/push'
import type { RefChange } from './sync'
import { db } from '@stacksjs/database'
import { ZERO_SHA } from '../Git/push'

/** What a sync found, as the updates a push of the same refs would carry. */
export function updatesFromChanges(changes: readonly RefChange[]): RefUpdate[] {
  return changes.map((change) => {
    const kind: RefKind = change.ref.startsWith('refs/heads/')
      ? 'branch'
      : change.ref.startsWith('refs/tags/') ? 'tag' : 'other'

    const name = kind === 'branch'
      ? change.ref.slice('refs/heads/'.length)
      : kind === 'tag' ? change.ref.slice('refs/tags/'.length) : change.ref

    return {
      ref: change.ref,
      kind,
      name,
      // A created ref had nothing before it and a deleted one has nothing
      // after: the all-zero sha, which is how a push says the same thing.
      before: change.before ?? ZERO_SHA,
      after: change.after ?? ZERO_SHA,
      change: change.kind,
    }
  })
}

export interface MirrorWorkflowInput {
  repository: { id: number | string, name?: unknown, disk_path?: unknown, owner_type?: unknown, owner_id?: unknown }
  owner: string
  defaultBranch: string
  /** What this sync moved. Empty when the fetch found nothing new. */
  changes: readonly RefChange[]
  /** The default branch's head now, for a mirror whose definitions were never read. */
  head: string | null
}

/**
 * Run what this sync means for a mirror that runs its workflows.
 *
 * Moved refs go through `syncFromPush` exactly as a push would. A sync that
 * moved nothing still registers the definitions when none exist yet: turning
 * `run_workflows` on for a mirror that is already current would otherwise do
 * nothing until the upstream's next commit, which reads as the switch being
 * broken. Never throws - a sync is done when the refs are fetched, and CI is a
 * consequence of it, not a condition.
 */
export async function runMirrorWorkflows(input: MirrorWorkflowInput): Promise<void> {
  try {
    const { syncDefinitions, syncFromPush } = await import('../../Listeners/SyncWorkflows')

    if (input.changes.length > 0) {
      const updates = updatesFromChanges(input.changes)

      await syncFromPush({
        repositoryId: Number(input.repository.id),
        owner: input.owner,
        defaultBranch: input.defaultBranch,
        updates,
      })

      await announceNewRuns(Number(input.repository.id), updates)
      return
    }

    if (!input.head || await hasDefinitions(Number(input.repository.id)))
      return

    await syncDefinitions(input.repository, input.owner, input.head)
  }
  catch (error) {
    console.error('[mirror] could not run the mirror\'s workflows:', error)
  }
}

/**
 * Tell the upstream about the runs this sync just started.
 *
 * A run is announced when it *moves*, and a new one has not moved yet: it is
 * `queued` from the start, or `waiting` when its concurrency group is busy. On the
 * upstream commit that is the most useful moment to say something - "CI is
 * coming" is what keeps somebody from merging before it reports - so the runs
 * this sync created are reported once here, before any runner has them.
 */
export async function announceNewRuns(repositoryId: number, updates: readonly RefUpdate[], fetchImpl?: typeof fetch): Promise<void> {
  const heads = updates
    .filter(update => update.change !== 'deleted' && update.kind !== 'other')
    .map(update => update.after)

  if (heads.length === 0)
    return

  const runs: any[] = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(['workflow_runs.id as id', 'workflow_runs.number as number', 'workflow_runs.state as state', 'workflow_runs.head_sha as head_sha'])
    .where('workflows.repository_id', '=', repositoryId)
    .where('workflow_runs.head_sha', 'in', heads)
    .where('workflow_runs.state', 'in', ['queued', 'waiting', 'paused'])
    .execute()
    .catch(() => [])

  const { reportRunUpstream } = await import('./upstreamStatus')

  for (const run of runs) {
    await reportRunUpstream(repositoryId, {
      id: Number(run.id),
      number: Number(run.number),
      state: String(run.state),
      headSha: String(run.head_sha),
    }, fetchImpl)
  }
}

async function hasDefinitions(repositoryId: number): Promise<boolean> {
  const row = await db
    .selectFrom('workflows')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}
