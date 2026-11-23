import { parseCron } from '@stacksjs/cron'
import { db } from '@stacksjs/database'
import { servablePathFor } from '../Actions/Git/access'
import { resolveDispatchRef } from '../Actions/Git/dispatchRef'
import { ownerHandleFor } from '../Actions/Repo/owner'
import { discoverWorkflows } from '../Actions/Workflow/discover'
import { withRedeliveryKey } from '../Actions/Workflow/redelivery'
import { digestOf } from '../Actions/Workflow/sync'

/**
 * `on: schedule`, which was stored on every version and read by nothing.
 *
 * A workflow with a cron expression registered it, showed it, and never ran -
 * the third trigger in this phase to be parsed and inert. A nightly job is
 * exactly the kind of thing somebody sets up once and does not check, so it is
 * also the trigger where silence is most expensive.
 *
 * A sweep rather than a timer armed per workflow. A timer has to survive a
 * restart and a redeploy; a sweep reads what is actually due, so a process that
 * dies between two minutes loses nothing but the minutes it was dead.
 *
 * **What stops a cron firing twice is the compare-and-swap on
 * `last_scheduled_at`**, not the run table's unique index - a scheduled run
 * repeats at the same ref and the same commit by design, so the index cannot
 * tell a second night from a duplicate.
 */
export default {
  handle: async (): Promise<{ swept: number, created: number }> => {
    return sweepSchedules()
  },
}

/**
 * A ceiling on how far back a sweep will look.
 *
 * An instance that was off for a week should not wake up and fire seven nightly
 * runs at once - nobody wants the backlog, and the seventh is the only one
 * whose result anybody would read. One catch-up run is the useful behaviour and
 * this is what enforces it.
 */
const MAX_CATCHUP_MS = 6 * 60 * 60 * 1000

export async function sweepSchedules(now = new Date()): Promise<{ swept: number, created: number }> {
  const workflows = await db
    .selectFrom('workflows')
    .select(['id', 'repository_id', 'name', 'path', 'last_scheduled_at'])
    .where('state', '=', 'active')
    .execute()

  let swept = 0
  let created = 0

  // A CI mirror's `workflows:` allowlist, read once per repository. A nightly
  // the mirror did not list stays upstream's to run (and anybody's by hand).
  const { mirrorWorkflowPaths } = await import('../Actions/Workflow/dispatch')
  const { workflowAllowed } = await import('../Actions/Mirror/runnerMap')
  const allowlists = new Map<number, string | null>()
  const targets = new Map<number, Awaited<ReturnType<typeof scheduledTarget>>>()

  for (const workflow of workflows) {
    const repositoryId = Number(workflow.repository_id)
    if (!allowlists.has(repositoryId))
      allowlists.set(repositoryId, await mirrorWorkflowPaths(repositoryId))
    if (!workflowAllowed(allowlists.get(repositoryId), String(workflow.path ?? '')))
      continue

    const version = await db
      .selectFrom('workflow_versions')
      .select(['id', 'schedules', 'source_sha', 'content_digest', 'concurrency_group', 'cancel_in_progress'])
      .where('workflow_id', '=', Number(workflow.id))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()

    const expressions = String(version?.schedules ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    if (!version || expressions.length === 0)
      continue

    swept++

    const previous = workflow.last_scheduled_at ? new Date(String(workflow.last_scheduled_at)) : null

    /*
     * A workflow that has never been swept does not fire immediately.
     *
     * Recording "now" and firing from the next occurrence is the difference
     * between adding a nightly workflow and having it run the moment you push
     * it - which looks like a bug even when the cron says 03:00.
     */
    if (!previous) {
      await stamp(Number(workflow.id), null, now)
      continue
    }

    const floor = new Date(Math.max(previous.getTime(), now.getTime() - MAX_CATCHUP_MS))

    if (!isDue(expressions, floor, now))
      continue

    if (!targets.has(repositoryId))
      targets.set(repositoryId, await scheduledTarget(repositoryId))
    const target = targets.get(repositoryId)
    // The Git ref can move before the push listener refreshes its definitions.
    // Leave this occurrence available until the registered workflow matches.
    if (!target || target.digests.get(String(workflow.path)) !== version.content_digest)
      continue

    /*
     * Claim the minute before doing the work.
     *
     * Guarded on the value that was read, so two sweeps racing means one of
     * them updates nothing and dispatches nothing. The alternative is a nightly
     * deploy that runs twice because a second worker woke up.
     */
    const claimed = await stamp(Number(workflow.id), workflow.last_scheduled_at, now)

    if (!claimed)
      continue

    const made = await createScheduledRun(workflow, version, target)

    if (made)
      created++
  }

  return { swept, created }
}

/** Whether any of these expressions has an occurrence in (after, until]. */
export function isDue(expressions: readonly string[], after: Date, until: Date): boolean {
  for (const expression of expressions) {
    try {
      const next = parseCron(expression, after)

      if (next && next.getTime() > after.getTime() && next.getTime() <= until.getTime())
        return true
    }
    catch {
      /*
       * `parseCron` throws on an expression it cannot read, and one repository
       * with a typo must not take every other repository's schedule down with
       * it. Not due is the honest answer: the workflow does not run, which is
       * what an unreadable schedule means.
       *
       * The interface has the same string and can say so; a sweep that dies is
       * the failure nobody can see.
       */
    }
  }

  return false
}

/** Record the sweep, guarded on what was read. Returns whether this caller won. */
async function stamp(workflowId: number, expected: unknown, now: Date): Promise<boolean> {
  let query = db
    .updateTable('workflows')
    .set({ last_scheduled_at: now.toISOString() })
    .where('id', '=', workflowId)

  /*
   * `whereNull`, not `where(column, 'is', null)`: this builder parameterises
   * the null and Postgres answers "syntax error at or near $3". The guard has
   * to hold for the never-swept case too, or the very first sweep of a new
   * workflow is the one that can double-fire.
   */
  query = expected === null || expected === undefined
    ? query.whereNull('last_scheduled_at')
    : query.where('last_scheduled_at', '=', expected)

  const result: any = await query.execute()

  /*
   * Three shapes, because this builder has answered with all of them: a bare
   * number, a result object carrying `numUpdatedRows`, and an array of those.
   * Reading only one of them is how the compare-and-swap silently always loses
   * and nothing is ever dispatched - which is exactly what happened here first.
   */
  const rows = typeof result === 'number'
    ? result
    : Array.isArray(result)
      ? (result[0]?.numUpdatedRows ?? result.length)
      : result?.numUpdatedRows

  return Number(rows ?? 0) > 0
}

async function scheduledTarget(repositoryId: number) {
  const repository = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id', 'default_branch'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  if (!repository)
    return null

  const owner = await ownerHandleFor(repository)
  const gitDir = owner && await servablePathFor(owner, String(repository.name))
  if (!gitDir)
    return null

  const target = await resolveDispatchRef(gitDir, `refs/heads/${repository.default_branch || 'main'}`)
  if (!target.ok)
    return null

  const files = await discoverWorkflows(gitDir, target.sha)
  return { ref: target.ref, sha: target.sha, digests: new Map(files.map(file => [file.path, digestOf(file.source)])) }
}

/** The branch head supplies the checkout; the registered version supplies the job graph. */
async function createScheduledRun(workflow: any, version: any, { ref, sha }: { ref: string, sha: string }): Promise<boolean> {
  const { resolveGroup } = await import('../Actions/Workflow/concurrency')
  const { startRun } = await import('../Actions/Workflow/dispatch')

  const group = resolveGroup(version.concurrency_group, {
    workflow: String(workflow.name || workflow.path || ''),
    eventName: 'schedule',
    ref,
    sha,
  })

  try {
    await startRun({
      values: withRedeliveryKey({
        workflow_version_id: Number(version.id),
        repository_id: Number(workflow.repository_id),
        state: 'queued',
        event: 'schedule',
        event_ref: ref,
        head_sha: sha,
        definition_sha: String(version.source_sha),
        // The repository's own definition on its own default branch: there is
        // no untrusted tree in this path, and nobody typed anything.
        trusted: true,
        actor_id: null,
        concurrency_group: group,
        started_at: null,
      }),
      versionId: Number(version.id),
    })

    return true
  }
  catch {
    /*
     * The minute is already claimed, so a failure here costs this occurrence
     * and not the next one. Throwing would fail the whole sweep and take every
     * other repository's schedule with it.
     */
    return false
  }
}
