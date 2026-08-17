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
 * What the jobs this one waited on produced.
 *
 * Keyed by job id, in the shape `needs.<job>.outputs.<name>` reads. A job that
 * needed nothing gets an empty object rather than nothing, so an expression
 * reading `needs.build.outputs.x` is null rather than an error - which is the
 * rule everywhere else in the expression language.
 */
async function outputsOfNeeds(runId: number, jobKey: string): Promise<Record<string, unknown>> {
  const job: any = await db
    .selectFrom('workflow_jobs')
    .select(['needs'])
    .where('workflow_run_id', '=', runId)
    .where('job_id', '=', jobKey)
    .executeTakeFirst()

  const needs = String(job?.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)

  if (needs.length === 0)
    return {}

  const rows: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state', 'outputs'])
    .where('workflow_run_id', '=', runId)
    .where('job_id', 'in', needs)
    .execute()

  const answer: Record<string, unknown> = {}

  for (const row of rows) {
    answer[String(row.job_id)] = {
      // `result` is what Actions calls it, and a dependent job's `if:` reads it
      // as often as it reads an output.
      result: String(row.state) === 'succeeded' ? 'success' : String(row.state),
      outputs: readJson(row.outputs),
    }
  }

  return answer
}

/** A stored JSON column as an object, or nothing when it holds nothing readable. */
function readJson(value: unknown): Record<string, unknown> {
  const text = String(value ?? '').trim()

  if (!text)
    return {}

  try {
    const parsed = JSON.parse(text)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

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

    /*
     * The job's own definition row, for its declared outputs. Read separately
     * from the steps because it is one row rather than many, and joining it
     * onto every step would carry the same JSON once per step.
     */
    /*
     * The run's own job row, for the matrix combination it was created for.
     * `claimNextJob` returns the identity it claimed rather than the whole row,
     * deliberately - the claim is a guarded write and widening it would mean
     * widening the statement whose narrowness is the point.
     */
    const jobRow: any = await db
      .selectFrom('workflow_jobs')
      .select(['matrix_values', 'timeout_minutes'])
      .where('id', '=', claimed.jobId)
      .executeTakeFirst()

    const definitionJob: any = await db
      .selectFrom('workflow_version_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.workflow_version_id', '=', 'workflow_version_jobs.workflow_version_id')
      .select(['workflow_version_jobs.outputs as outputs'])
      .where('workflow_runs.id', '=', claimed.runId)
      .where('workflow_version_jobs.job_id', '=', claimed.jobKey)
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
        // What the step passes to what it uses, and whether the job survives
        // its failure. Both were stored and neither was sent, so a `uses:` step
        // ran with no inputs and `continue-on-error` did nothing.
        'workflow_version_steps.step_id as step_id',
        'workflow_version_steps.condition as condition',
        'workflow_version_steps.inputs as inputs',
        'workflow_version_steps.shell as shell',
        'workflow_version_steps.continue_on_error as continue_on_error',
        'workflow_version_steps.env as env',
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
        /*
         * What this job is expected to produce, and what the jobs it waited on
         * produced.
         *
         * The first is expressions over this job's steps, resolved by the runner
         * once they have run. The second is values, already resolved by whoever
         * ran those jobs - which is what makes `needs.build.outputs.name` mean
         * anything at all.
         */
        outputs: readJson(definitionJob?.outputs),
        /*
         * The matrix combination this job is, so `${{ matrix.node }}` means
         * something inside a step and in an output expression. Stored on the job
         * when the run was created, because a combination is a fact about the
         * job rather than about the definition.
         */
        matrix_values: readJson(jobRow?.matrix_values),
        needs: await outputsOfNeeds(claimed.runId, String(claimed.jobKey)),
        /*
         * How long this job is allowed to take, in minutes.
         *
         * Sent so the runner can stop it *and say why*. The control plane has
         * its own backstop for a runner that ignores this or dies holding the
         * job, but a timeout enforced only by a lease sweep reads as "the
         * runner disappeared", which sends somebody looking at their
         * infrastructure instead of at the step that hangs.
         */
        timeout_minutes: jobRow?.timeout_minutes === null || jobRow?.timeout_minutes === undefined
          ? null
          : Number(jobRow.timeout_minutes),
        steps: steps.map(step => ({
          position: Number(step.position ?? 0),
          name: step.name ?? null,
          /*
           * The step's own id and condition.
           *
           * The id is what `steps.<id>.outputs` is keyed on, and the condition
           * is evaluated by the runner rather than here: a step's `if:` reads
           * what the steps before it produced, which does not exist until they
           * have run.
           */
          id: step.step_id ?? null,
          if: step.condition ?? null,
          run: step.command ?? null,
          uses: step.uses ?? null,
          working_directory: step.working_directory ?? null,
          shell: step.shell ?? null,
          // `with:` and `env:` are JSON as stored; a runner should not have to
          // know that, so they are sent as objects.
          with: readJson(step.inputs),
          env: readJson(step.env),
          continue_on_error: step.continue_on_error === true,
        })),
      },
    })
  },
})
