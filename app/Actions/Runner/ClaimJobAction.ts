import { Action } from '@stacksjs/actions'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
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
 * The response carries what the runner needs to do the work and nothing else -
 * including a credential minted for this claim alone, which is what everything
 * afterwards authenticates with. It carries no *repository* secret: a job's environment is assembled after
 * the fork policy has been applied, and this endpoint predates any of that -
 * by [the threat model](../../../docs/ci-threat-model.md) an untrusted run
 * never receives one at all.
 */
/**
 * The owner's handle, for the `owner/name` a runner clones by.
 *
 * One query per claim, which is one query per job rather than per poll: a
 * claim that found nothing never reaches here.
 */
async function ownerHandleOf(context: any): Promise<string> {
  const table = String(context.owner_type) === 'organization' ? 'organizations' : 'users'

  const owner: any = await db
    .selectFrom(table as any)
    .select(['handle'])
    .where('id', '=', Number(context.owner_id))
    .executeTakeFirst()

  return String(owner?.handle ?? '')
}

export default new Action({
  name: 'ClaimJob',
  description: 'Take the next job this runner may run',
  method: 'POST',

  responses: {
    426: {
      description: 'This runner speaks a protocol version the server does not. The body says which end is behind; every answer carries X-Runner-Protocol-Supported.',
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
  },

  responseHeaders: {
    'X-Runner-Protocol-Supported': {
      description: 'The protocol version, or range of versions, this server speaks. On every answer, so a runner about to be retired learns it from an ordinary poll rather than from the first request that fails.',
      schema: { type: 'string' },
    },
  },

  async handle(request: any) {
    /*
     * Before anything else, including the credential.
     *
     * A runner speaking a protocol this server does not is going to
     * misread whatever it is handed, and telling it that its token is
     * fine first only delays the confusion. The refusal names which way
     * the mismatch runs, because upgrading a fleet and upgrading a
     * server are different afternoons.
     */
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const runner = await authenticateRunner(request)
    if (!runner)
      return runnerJson({ error: 'Unknown runner' }, 401)

    const claimed = await claimNextJob(runner.facts)
    if (!claimed)
      return runnerJson({ job: null })

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
        // Where the code is, which every runner needs and none was told. A
        // same-host runner reads the bare repository directly; one on another
        // machine clones the URL. Both need to know which repository this is,
        // and a bare name is ambiguous across owners.
        'repositories.owner_type as owner_type',
        'repositories.owner_id as owner_id',
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

    return runnerJson({
      job: {
        id: claimed.jobId,
        key: claimed.jobKey,
        lease_expires_at: claimed.leaseExpiresAt,
        // Returned once, here, and never readable again: the column holds a
        // hash. Everything the runner does about this job is authenticated
        // with it rather than with the credential it registered with.
        token: claimed.jobToken,
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
        /*
         * `owner/name`, which is what a runner needs to find or clone the
         * code. The bare name was ambiguous the moment two owners had a
         * repository called `api`.
         */
        repository_full_name: context ? `${await ownerHandleOf(context)}/${context.repository}` : null,
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
