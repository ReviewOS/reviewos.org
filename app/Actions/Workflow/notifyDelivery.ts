/**
 * Delivering what the rules asked for, when a run ends.
 *
 * Split from the matching in `notifyRules.ts` for the reason every other pair
 * in this codebase is split: the decision is worth testing on its own, and the
 * decision here is whose phone buzzes.
 *
 * Never throws. A notification is a consequence of something that already
 * happened, and failing to record one must not fail the settle pass that was
 * recording the run's conclusion.
 */

import { db } from '@stacksjs/database'
import type { NotificationRule, RunOutcome } from './notifyRules'
import { matchRules, notificationTitle } from './notifyRules'
import { isNotFalse } from '../Support/sql'

/** The rules a repository has, in the shape the matcher takes. */
export async function rulesFor(repositoryId: number): Promise<NotificationRule[]> {
  const rows = await db
    .selectFrom('workflow_notification_rules')
    .select(['id', 'user_id', 'workflow', 'branch', 'job_key', 'condition'])
    .where('repository_id', '=', repositoryId)
    // Ordered, because `matchRules` breaks a tie between two equally narrow
    // rules by keeping the first. Without this the tie is broken by whatever
    // order the database felt like returning, so the sentence in somebody's
    // notification could differ between two deliveries of the same run.
    .orderBy('id')
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    workflow: String(row.workflow ?? '*'),
    branch: String(row.branch ?? '*'),
    jobKey: String(row.job_key ?? ''),
    condition: String(row.condition ?? 'failure') as NotificationRule['condition'],
  }))
}

/**
 * What happened, and what happened last time.
 *
 * The previous run is read per workflow *and* per branch, because that is what
 * `recovery` means to a person: main going green again after main was broken,
 * not after somebody's branch was.
 */
export async function outcomeOfRun(runId: number): Promise<{ outcome: RunOutcome, repositoryId: number, runNumber: number } | null> {
  const run = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select([
      'workflow_runs.id as id',
      'workflow_runs.number as number',
      'workflow_runs.state as state',
      'workflow_runs.event_ref as event_ref',
      'workflow_runs.repository_id as repository_id',
      'workflow_runs.trusted as trusted',
      'workflows.id as workflow_id',
      'workflows.name as workflow_name',
      'workflows.path as workflow_path',
    ])
    .where('workflow_runs.id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  if (!run)
    return null

  /*
   * A fork's run tells nobody.
   *
   * The workflow comes from the base branch, but the run is somebody else's
   * code - and a stranger who can open a pull request should not be able to
   * make this instance message a maintainer on demand.
   */
  if (!isNotFalse(run.trusted))
    return null

  const branch = String(run.event_ref ?? '').replace(/^refs\/heads\//, '')

  const previous = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .select(['workflow_runs.state as state'])
    .where('workflow_versions.workflow_id', '=', Number(run.workflow_id))
    .where('workflow_runs.repository_id', '=', Number(run.repository_id))
    .where('workflow_runs.event_ref', '=', String(run.event_ref ?? ''))
    .where('workflow_runs.id', '<', runId)
    .where('workflow_runs.state', 'in', ['succeeded', 'failed', 'cancelled'])
    .orderBy('workflow_runs.id', 'desc')
    .limit(1)
    .executeTakeFirst()
    .catch(() => null)

  const jobs = await db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state'])
    .where('workflow_run_id', '=', runId)
    .execute()
    .catch(() => [])

  /*
   * The previous state of each job, so a per-job rule can say `recovery` too.
   *
   * One query for the whole previous run rather than one per job: a matrix of
   * twelve would otherwise be twelve round trips to answer a question about a
   * run that has already finished.
   */
  const previousJobs = previous
    ? await db
        .selectFrom('workflow_jobs')
        .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
        .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
        .select(['workflow_jobs.job_id as job_id', 'workflow_jobs.state as state'])
        .where('workflow_versions.workflow_id', '=', Number(run.workflow_id))
        .where('workflow_runs.event_ref', '=', String(run.event_ref ?? ''))
        .where('workflow_runs.id', '<', runId)
        .orderBy('workflow_runs.id', 'desc')
        .limit(50)
        .execute()
        .catch(() => [])
    : []

  const previousByJob = new Map<string, string>()

  for (const row of previousJobs) {
    const key = String(row.job_id)

    if (!previousByJob.has(key))
      previousByJob.set(key, String(row.state))
  }

  return {
    repositoryId: Number(run.repository_id),
    runNumber: Number(run.number),
    outcome: {
      workflowPath: String(run.workflow_path ?? ''),
      workflowName: String(run.workflow_name ?? ''),
      branch,
      state: String(run.state ?? ''),
      previousState: previous ? String(previous.state) : null,
      jobs: jobs.map(job => ({
        key: String(job.job_id),
        state: String(job.state),
        previousState: previousByJob.get(String(job.job_id)) ?? null,
      })),
    },
  }
}

/**
 * Tell whoever asked to be told.
 *
 * Delivered into phase 5's `notifications` table, so the recipient's own
 * settings decide whether that becomes an email, a push, or only the inbox -
 * which is why a rule names a person rather than an address.
 */
export async function deliverRunNotifications(runId: number): Promise<number> {
  try {
    const found = await outcomeOfRun(runId)

    if (!found)
      return 0

    // Nothing to say about a run still going: the settler calls this on every
    // pass, and only a finished run has an outcome to report.
    if (!['succeeded', 'failed', 'cancelled'].includes(found.outcome.state))
      return 0

    const rules = await rulesFor(found.repositoryId)

    if (rules.length === 0)
      return 0

    const matches = matchRules(rules, found.outcome)

    if (matches.length === 0)
      return 0

    const repository = await db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', found.repositoryId)
      .executeTakeFirst()

    if (!repository)
      return 0

    const { ownerHandleFor } = await import('../Repo/owner')
    const { permissionOn } = await import('../Git/access')
    const { repositoryViewAccess } = await import('../Repo/forView')

    const owner = await ownerHandleFor(repository) ?? ''
    const full = `${owner}/${String(repository.name)}`
    const url = `/${full}/run/${found.runNumber}`

    let delivered = 0

    for (const match of matches) {
      /*
       * A notification is not a way to learn that a private repository exists.
       * The reader has to be able to see the run it is about, asked with the
       * same function every page and endpoint asks - and a rule outlives the
       * access that justified it, so this is checked at delivery rather than
       * when the rule was written.
       */
      const grants = await permissionOn(repository, match.rule.userId)

      if (!repositoryViewAccess(repository, match.rule.userId, grants).readable)
        continue

      const recovered = match.rule.condition === 'recovery'

      await db.insertInto('notifications').values({
        user_id: match.rule.userId,
        type: 'workflow_run',
        data: JSON.stringify({
          title: notificationTitle({
            repository: full,
            runNumber: found.runNumber,
            workflowName: found.outcome.workflowName || found.outcome.workflowPath,
            jobKey: match.jobKey,
            state: match.state,
            recovered,
          }),
          url,
          // Said in the notification, because the first question about an alert
          // is why it reached you - and a rule somebody else wrote about a
          // branch you have forgotten is the usual answer.
          reason: reasonFor(match.rule),
          repository: full,
          number: found.runNumber,
        }),
      }).execute()

      delivered++
    }

    return delivered
  }
  catch (error) {
    // Reported rather than swallowed: an inbox that quietly stops filling is a
    // failure nobody can see.
    console.error('[notify] could not deliver a run notification:', error)

    return 0
  }
}

/** The rule, as the sentence that explains the alert. */
function reasonFor(rule: NotificationRule): string {
  const where = rule.branch === '*' ? 'any branch' : `\`${rule.branch}\``
  const what = rule.workflow === '*' ? 'any workflow' : `\`${rule.workflow}\``
  const which = rule.jobKey ? ` job \`${rule.jobKey}\`` : ''

  if (rule.condition === 'recovery')
    return `you asked to hear when ${what}${which} passes again on ${where}`

  return `you asked to hear about ${rule.condition === 'always' ? 'every run of' : `${rule.condition} of`} ${what}${which} on ${where}`
}
