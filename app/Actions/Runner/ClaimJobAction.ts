import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { authenticateRunner } from './authenticate'
import { claimNextJob } from './claim'

/**
 * What a runner asks for when it has capacity.
 *
 * Authenticated by the runner's own credential, not a user's session: there is
 * nobody at the keyboard, and a machine polling every few seconds is exactly
 * the caller a session was never meant to describe.
 *
 * **No work is the ordinary answer**, so it is a 200 with `job: null` rather
 * than a 404. A runner polling an idle instance is not making a mistake, and an
 * error status for the common case is how a fleet's logs fill with red that
 * means nothing.
 *
 * The response carries what the runner needs to do the work and nothing else.
 * In particular it carries no secret: a job's environment is assembled after
 * the fork policy has been applied, and this endpoint predates any of that -
 * by [the threat model](../../../docs/ci-threat-model.md) an untrusted run
 * never receives one at all.
 */
export default new Action({
  name: 'ClaimJob',
  description: 'Take the next job this runner may run',
  method: 'POST',

  async handle(request: any) {
    const runner = await authenticateRunner(request)
    if (!runner)
      return response.json({ error: 'Unknown runner' }, 401)

    const claimed = await claimNextJob(runner.facts)
    if (!claimed)
      return response.json({ job: null })

    // Read after the claim rather than joined into it: the claim is a guarded
    // write and adding columns to it would mean widening the statement whose
    // narrowness is the point.
    const context: any = await db
      .selectFrom('workflow_runs')
      .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
      .select([
        'workflow_runs.id as run_id',
        'workflow_runs.number as run_number',
        'workflow_runs.head_sha as head_sha',
        'workflow_runs.event as event',
        'workflow_runs.event_ref as event_ref',
        'workflow_runs.trusted as trusted',
        'repositories.name as repository',
      ])
      .where('workflow_runs.id', '=', claimed.runId)
      .executeTakeFirst()

    const steps: any[] = await db
      .selectFrom('workflow_version_steps')
      .innerJoin(
        'workflow_version_jobs',
        'workflow_version_jobs.id',
        '=',
        'workflow_version_steps.workflow_version_job_id',
      )
      .innerJoin('workflow_runs', 'workflow_runs.workflow_version_id', '=', 'workflow_version_jobs.workflow_version_id')
      .select([
        'workflow_version_steps.position as position',
        'workflow_version_steps.name as name',
        'workflow_version_steps.command as command',
        'workflow_version_steps.uses as uses',
        'workflow_version_steps.working_directory as working_directory',
      ])
      .where('workflow_runs.id', '=', claimed.runId)
      .where('workflow_version_jobs.job_id', '=', claimed.jobKey)
      .orderBy('workflow_version_steps.position')
      .execute()

    return response.json({
      job: {
        id: claimed.jobId,
        key: claimed.jobKey,
        lease_expires_at: claimed.leaseExpiresAt,
        run: {
          id: claimed.runId,
          number: Number(context?.run_number ?? 0),
          head_sha: context?.head_sha ?? null,
          event: context?.event ?? null,
          ref: context?.event_ref ?? null,
          // Said plainly, because a runner may want to refuse work it is not
          // willing to run: an untrusted run is a fork's code.
          trusted: Boolean(context?.trusted),
        },
        repository: context?.repository ?? null,
        steps: steps.map(step => ({
          position: Number(step.position ?? 0),
          name: step.name ?? null,
          run: step.command ?? null,
          uses: step.uses ?? null,
          working_directory: step.working_directory ?? null,
        })),
      },
    })
  },
})
