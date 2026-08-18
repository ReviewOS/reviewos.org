/**
 * `notify:` on a job: telling a person that this job finished.
 *
 * Distinct from workflow-level notification, which is the repository's
 * webhooks and its watchers' subscriptions. This is the other thing people
 * want and cannot express: **one job in a long pipeline matters to somebody
 * specific**, and a nightly run with forty green jobs and one red deploy is a
 * notification nobody reads unless it names the job.
 *
 * **It notifies people on this instance, never an address.** A workflow file is
 * editable by anybody who can push, and a `notify:` that took an arbitrary
 * email address would make every repository here a mail relay with a spam
 * problem. Naming a user means their own preferences decide the channel - inbox
 * always, email and push if they asked for them - which is also the answer to
 * "how do I get a text message": that is a per-person setting, not a workflow
 * one.
 */

export type NotifyCondition = 'success' | 'failure' | 'always'

export interface NotifyEntry {
  /** The handle of somebody on this instance. */
  user: string
  condition: NotifyCondition
}

/** A job may not notify a crowd. */
export const MAX_NOTIFY = 5

/**
 * Which entries this outcome should deliver.
 *
 * `failure` covers cancelled as well as failed, because a deploy that was
 * cancelled did not happen either, and somebody waiting to hear that it landed
 * needs to know it did not.
 */
export function notifyFor(entries: readonly NotifyEntry[], state: string): NotifyEntry[] {
  const failed = state === 'failed' || state === 'cancelled'
  const succeeded = state === 'succeeded'

  return entries.filter((entry) => {
    if (entry.condition === 'always')
      return failed || succeeded

    return entry.condition === 'failure' ? failed : succeeded
  })
}

/** The `notify` entries stored on a job row, whatever shape the column is in. */
export function notifyEntriesOf(settings: unknown): NotifyEntry[] {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings
    const entries = (parsed as { notify?: unknown } | null)?.notify

    if (!Array.isArray(entries))
      return []

    return entries
      .filter((one): one is { user: string, condition?: unknown } =>
        Boolean(one) && typeof (one as { user?: unknown }).user === 'string' && String((one as { user: string }).user).length > 0)
      .slice(0, MAX_NOTIFY)
      .map(one => ({
        user: String(one.user),
        condition: ['success', 'failure', 'always'].includes(String(one.condition)) ? String(one.condition) as NotifyCondition : 'always',
      }))
  }
  catch {
    return []
  }
}

/**
 * Deliver what a finished job asked for.
 *
 * Never throws, for the same reason the notification listener does not: a
 * notification is a consequence of something that already happened, and failing
 * to record one must not fail the settle pass that was recording a job's
 * outcome.
 */
export async function deliverJobNotify(input: { jobId: number, state: string }): Promise<number> {
  try {
    const { db } = await import('@stacksjs/database')

    const job = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'job_id', 'name', 'settings', 'notified_at', 'workflow_run_id'])
      .where('id', '=', input.jobId)
      .executeTakeFirst()

    if (!job || job.notified_at)
      return 0

    const wanted = notifyFor(notifyEntriesOf(job.settings), input.state)

    if (wanted.length === 0)
      return 0

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id', 'number', 'trusted', 'repository_id'])
      .where('id', '=', Number(job.workflow_run_id))
      .executeTakeFirst()

    if (!run)
      return 0

    /*
     * A fork's run notifies nobody.
     *
     * The workflow comes from the base branch, but the *run* is somebody else's
     * code, and a stranger who can open a pull request should not be able to
     * make this instance message a maintainer on demand.
     */
    if (run.trusted === false || run.trusted === 0)
      return 0

    const repository = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'visibility', 'owner_type', 'owner_id'])
      .where('id', '=', Number(run.repository_id))
      .executeTakeFirst()

    if (!repository)
      return 0

    /*
     * Claimed before delivering, guarded on the column being null. The settler
     * runs on every report, and a job that notified once per pass would be the
     * feature people turn off within a day.
     */
    const claimed = await db
      .updateTable('workflow_jobs')
      .set({ notified_at: new Date().toISOString() })
      .where('id', '=', Number(job.id))
      .whereNull('notified_at')
      .execute()

    /*
     * Three shapes, because this builder answers with all of them - the same
     * reading the scheduled sweep needs for its compare-and-swap.
     */
    const rows = typeof claimed === 'number'
      ? claimed
      : Array.isArray(claimed)
        ? (claimed[0]?.numUpdatedRows ?? claimed.length)
        : claimed?.numUpdatedRows

    if (Number(rows ?? 0) === 0)
      return 0

    const { ownerHandleFor } = await import('../Repo/owner')
    const { permissionOn } = await import('../Git/access')
    const { repositoryViewAccess } = await import('../Repo/forView')

    const owner = await ownerHandleFor(repository) ?? ''
    const url = `/${owner}/${repository.name}/run/${Number(run.number)}`
    const title = `${job.name ?? job.job_id} ${input.state} in ${owner}/${repository.name} run #${Number(run.number)}`

    let delivered = 0

    for (const entry of wanted) {
      const user = await db
        .selectFrom('users')
        .select(['id'])
        .where('handle', '=', entry.user)
        .executeTakeFirst()

      if (!user)
        continue

      /*
       * A notification is not a way to learn that a private repository exists.
       * The reader has to be able to see the run it is about, asked with the
       * same function every page and endpoint asks.
       */
      const grants = await permissionOn(repository, Number(user.id))

      if (!repositoryViewAccess(repository, Number(user.id), grants).readable)
        continue

      await db.insertInto('notifications').values({
        user_id: Number(user.id),
        type: 'workflow_job',
        data: JSON.stringify({
          title,
          url,
          reason: 'a workflow named you in this job\'s `notify:`',
          repository: `${owner}/${repository.name}`,
          number: Number(run.number),
        }),
      }).execute()

      delivered++
    }

    return delivered
  }
  catch (error) {
    // Reported rather than swallowed, like the notification listener: an inbox
    // that quietly stops filling is a failure nobody can see.
    console.error('[notify] could not deliver a job notification:', error)

    return 0
  }
}
