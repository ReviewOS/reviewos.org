import { Action } from '@stacksjs/actions'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
import { mintJobToken } from '../Workflow/jobToken'
import { secretsForJob } from '../Workflow/secrets'
import { variablesFor } from '../Workflow/variables'
import { db } from '@stacksjs/database'
import { authenticateRunner } from './authenticate'
import { claimNextJob, stopRequestedFor } from './claim'
import { eventPayload } from '../Workflow/eventPayload'
import { signWork } from '../Workflow/stepSignature'
import { environmentFor as pluginEnvironment, hookScriptsFor, poolPlugins, poolVerdict, preparedPluginsOf } from '../Plugin/prepare'
import { effectivePolicy } from '../Plugin/policy'
import { policyLevels } from '../Plugin/store'
import { repositoryPath } from '../Git/storage'

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
  const job = await db
    .selectFrom('workflow_jobs')
    .select(['needs'])
    .where('workflow_run_id', '=', runId)
    .where('job_id', '=', jobKey)
    .executeTakeFirst()

  const needs = String(job?.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean)

  if (needs.length === 0)
    return {}

  const rows = await db
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

  const owner = await db
    .selectFrom(table as any)
    .select(['handle'])
    .where('id', '=', Number(context.owner_id))
    .executeTakeFirst()

  return String(owner?.handle ?? '')
}

/**
 * The ref a run was created against, without the bookkeeping.
 *
 * A subject run records `refs/heads/main#issues/7/opened`, because the
 * redelivery index needs every issue event to look different and they all share
 * a head commit. That suffix is this instance's own bookkeeping and a step that
 * checks out `$GITHUB_REF` must never see it.
 */
function refOf(context: any): string {
  return String(context?.event_ref ?? '').split('#')[0] ?? ''
}

/** The subject half of that ref, for the payload. */
function subjectOf(eventRef: string): { kind: string, id: string, action: string } | null {
  const suffix = String(eventRef).split('#')[1]

  if (!suffix)
    return null

  const [kind, id, action] = suffix.split('/')

  return kind && id ? { kind, id, action: action ?? '' } : null
}

/** The address this runner reached, scheme and host, with nothing after it. */
function serverUrlOf(request: RequestInstance): string {
  const url = String(request?.url ?? '')

  try {
    const parsed = new URL(url)

    return `${parsed.protocol}//${parsed.host}`
  }
  catch {
    return ''
  }
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

  async handle(request: RequestInstance) {
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

    if (!claimed) {
      /*
       * No work is the ordinary answer, and "stop" is the one case where it
       * means something else.
       *
       * A poll is the only moment this instance can tell a runner anything -
       * it is somebody else's machine, and there is no connection to send a
       * signal down - so the answer to "have you got work" carries the answer
       * to "should I still be here".
       */
      const stop = await stopRequestedFor(runner.facts.id)

      if (stop) {
        await db
          .updateTable('runners')
          // Acknowledged by asking: the machine has been told, and a request
          // that stayed set would stop it again the next time it registered.
          .set({ stop_requested: null })
          .where('id', '=', runner.facts.id)
          .execute()

        return runnerJson({ job: null, stop })
      }

      return runnerJson({ job: null })
    }

    // Read after the claim rather than joined into it: the claim is a guarded
    // write and adding columns to it would mean widening the statement whose
    // narrowness is the point.
    const context = await db
      .selectFrom('workflow_runs')
      .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
      .select([
        'workflow_runs.id as run_id',
        'workflow_runs.number as run_number',
        'workflow_runs.attempt as run_attempt',
        'workflow_runs.head_sha as head_sha',
        'workflow_runs.event as event',
        'workflow_runs.event_ref as event_ref',
        'workflow_runs.trusted as trusted',
        'workflow_runs.actor_id as actor_id',
        'workflow_runs.pull_request_id as pull_request_id',
        'workflow_runs.dispatch_inputs as dispatch_inputs',
        'repositories.name as repository',
        'repositories.visibility as visibility',
        'repositories.default_branch as default_branch',
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
     * The workflow's name, the pull request it is about, and who started it.
     *
     * All three were read by something and sent by nothing: `github.workflow`
     * in an expression resolved to an empty string, `GITHUB_BASE_REF` was never
     * set so every "what changed on this pull request" action compared against
     * nothing, and `github.actor` was blank on a screen that says who pushed.
     */
    const workflow = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .innerJoin('workflow_runs', 'workflow_runs.workflow_version_id', '=', 'workflow_versions.id')
      .select(['workflows.name as name', 'workflows.path as path', 'workflow_versions.permissions as permissions'])
      .where('workflow_runs.id', '=', claimed.runId)
      .executeTakeFirst()

    const pull: any = context?.pull_request_id
      ? await db
          .selectFrom('pull_requests')
          .select(['number', 'title', 'state', 'draft', 'head_ref', 'base_ref', 'head_sha'])
          .where('id', '=', Number(context.pull_request_id))
          .executeTakeFirst()
      : null

    const actor: any = context?.actor_id
      ? await db
          .selectFrom('users')
          .select(['handle', 'name'])
          .where('id', '=', Number(context.actor_id))
          .executeTakeFirst()
      : null

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
    const jobRow = await db
      .selectFrom('workflow_jobs')
      .select([
        'matrix_values', 'timeout_minutes', 'settings', 'approved_at', 'parallel_index', 'parallel_total', 'uploaded_by_job_id',
        // `strategy.fail-fast` and `strategy.max-parallel`, which were copied
        // onto the run and read by the graph and by nothing a workflow could see.
        'fail_fast', 'max_parallel',
      ])
      .where('id', '=', claimed.jobId)
      .executeTakeFirst()

    const definitionJob = await db
      .selectFrom('workflow_version_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.workflow_version_id', '=', 'workflow_version_jobs.workflow_version_id')
      .select([
        'workflow_version_jobs.outputs as outputs',
        'workflow_version_jobs.env as env',
        'workflow_version_jobs.permissions as permissions',
      ])
      .where('workflow_runs.id', '=', claimed.runId)
      .where('workflow_version_jobs.job_id', '=', claimed.jobKey)
      .executeTakeFirst()

    /*
     * A generated job's steps come from the run, not from a definition.
     *
     * A job uploaded by another job was in no workflow file, so the version
     * tables have nothing for it - and reading them anyway is how it reached a
     * runner with an empty step list, did nothing, and reported success. The
     * row's own columns are the record for exactly those jobs.
     */
    const generated = jobRow?.uploaded_by_job_id ? await db
      .selectFrom('workflow_steps')
      .select([
        'position', 'name', 'command', 'uses', 'working_directory',
        'step_id', 'condition', 'inputs', 'shell', 'continue_on_error', 'env', 'timeout_minutes',
      ])
      .where('workflow_job_id', '=', claimed.jobId)
      .orderBy('position')
      .execute() : []

    const steps: any[] = generated.length > 0 ? generated : await db
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
        'workflow_version_steps.timeout_minutes as timeout_minutes',
      ])
      .where('workflow_runs.id', '=', claimed.runId)
      .where('workflow_version_jobs.job_id', '=', claimed.jobKey)
      .orderBy('workflow_version_steps.position')
      .execute()

    /*
     * The token this job talks to the API with.
     *
     * `permissions:` has been parsed, stored and shown on the run screen since
     * the beginning and acted on by nothing - the same defect as `fail-fast`
     * and `timeout-minutes` before it. Minted here because this is where the
     * trust flag is: a fork's pull request gets read access whatever its own
     * workflow file declares about itself.
     */
    const minted = await mintJobToken({
      runId: claimed.runId,
      jobId: claimed.jobId,
      repositoryId: claimed.repositoryId,
      actorId: context?.actor_id ? Number(context.actor_id) : null,
      trusted: Boolean(context?.trusted),
      workflowPermissions: workflow?.permissions ?? null,
      jobPermissions: definitionJob?.permissions ?? null,
    })

    const runnerSteps = steps.map(step => ({
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
      // The narrow timeout, which the runner applies to this step alone.
      timeout_minutes: step.timeout_minutes === null || step.timeout_minutes === undefined
        ? null
        : Number(step.timeout_minutes),
    }))

    /*
     * The job's plugins: the pool's half of the policy, then the hook scripts.
     *
     * Dispatch checked the instance's rules and the owner's; which pool a job
     * runs in is a fact about the machine that claimed it, so this is the first
     * moment the last level can be asked. A refusal fails the job with the
     * reason rather than leaving it queued - a job no machine in this pool may
     * run is not work waiting for a runner, it is work that will never happen.
     */
    /*
     * The rows this job shares its name with, in expansion order.
     *
     * A matrix of four is four rows under one `job_id`, and `strategy.job-index`
     * is which of them this is - so the answer is a position among siblings
     * rather than anything on the row itself.
     */
    const siblings = await db
      .selectFrom('workflow_jobs')
      .select(['id'])
      .where('workflow_run_id', '=', claimed.runId)
      .where('job_id', '=', claimed.jobKey)
      .orderBy('position')
      .execute()

    const attached = await poolPlugins(claimed.poolId)

    if (!attached.ok) {
      await db
        .updateTable('workflow_jobs')
        .set({ state: 'failed', finished_at: new Date().toISOString(), condition_reason: attached.reason })
        .where('id', '=', claimed.jobId)
        .execute()

      return runnerJson({ job: null })
    }

    // The operator's first, then the workflow's: a fleet-wide profiler wraps
    // what a repository asked for rather than the other way round.
    const prepared = [...attached.plugins, ...preparedPluginsOf(jobRow?.settings)]
    const plugins: any[] = []

    if (prepared.length > 0) {
      const verdict = poolVerdict({
        plugins: prepared,
        policy: effectivePolicy(await policyLevels({ poolId: claimed.poolId ?? undefined })),
      })

      if (!verdict.ok) {
        await db
          .updateTable('workflow_jobs')
          .set({ state: 'failed', finished_at: new Date().toISOString(), condition_reason: verdict.reason })
          .where('id', '=', claimed.jobId)
          .execute()

        return runnerJson({ job: null })
      }

      const located = context ? repositoryPath(await ownerHandleOf(context), String(context.repository)) : { path: null as string | null }

      for (const plugin of prepared) {
        plugins.push({
          name: plugin.name,
          reference: plugin.reference,
          sha: plugin.sha,
          requires: plugin.requires,
          // The parameters as environment, namespaced by plugin: two plugins
          // that both take a `registry` are ordinary, and one reading the
          // other's value is not a bug anybody would find quickly.
          environment: pluginEnvironment(plugin),
          hooks: await hookScriptsFor({ plugin, gitDir: located.path ?? '' }),
        })
      }
    }

    /*
     * The signature over the work, which a pool can be set to require.
     *
     * Over the mapped steps rather than over the rows, because the runner can
     * only check what it received: a signature over something the payload does
     * not carry is one that never verifies. Null when the key cannot be read -
     * `signWork` says why it declines to fail the claim.
     */
    const signature = await signWork({
      runId: claimed.runId,
      jobId: claimed.jobId,
      matrix: readJson(jobRow?.matrix_values) as Record<string, unknown> | null,
      steps: runnerSteps.map((step) => ({
        run: step.run,
        uses: step.uses,
        env: step.env as Record<string, string> | null,
        workingDirectory: step.working_directory,
      })),
    })

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
          ref: refOf(context),
          workflow: workflow?.name ? String(workflow.name) : String(workflow?.path ?? ''),
          /*
           * Who started it, by handle. Empty when nothing recorded somebody -
           * a scheduled run has no actor, and inventing one would put a name
           * on a decision nobody made.
           */
          actor: actor?.handle ? String(actor.handle) : '',
          // A pull request's branches, which is what half the ecosystem's
          // "changed files" logic is built on.
          head_ref: pull?.head_ref ? String(pull.head_ref) : '',
          base_ref: pull?.base_ref ? String(pull.base_ref) : '',
          /*
           * Which attempt of this run this is, so `GITHUB_RUN_ATTEMPT` means
           * something. It was a literal 1 until re-runs existed to make it a
           * number - which is the shape of bug this phase keeps finding: a
           * value carried all the way to the runner and computed by nothing.
           */
          attempt: Number(context?.run_attempt ?? 1),
          // Said plainly, because a runner may want to refuse work it is not
          // willing to run: an untrusted run is a fork's code.
          trusted: Boolean(context?.trusted),
        },
        repository: context?.repository ?? null,
        /*
         * Where this instance is, taken from the address the runner just
         * reached rather than from configuration.
         *
         * A configured URL is the one behind the proxy as often as not, and a
         * `GITHUB_SERVER_URL` that does not resolve from a runner is worse than
         * none: every action that builds a link with it produces a link nobody
         * can follow. The host it called is by definition one it can call.
         */
        server_url: serverUrlOf(request),
        api_url: `${serverUrlOf(request)}/api`,
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
        /*
         * Which shard this is, when the job asked for `parallelism:`.
         *
         * Zero-based, matching what the runner exports and what
         * `/api/repos/tests/split` takes - the whole point of the attribute is
         * that a job can hand these two numbers straight to that endpoint and
         * get its share back, with no arithmetic in the workflow.
         *
         * Null for an ordinary job rather than `0 of 1`: a script asking "am I
         * a shard" should get an answer, and `0 of 1` is indistinguishable from
         * the first shard of a job somebody reduced to one copy.
         */
        /*
         * `strategy`, the eleventh context: `fail-fast`, `max-parallel`, and
         * which of a matrix's jobs this one is.
         *
         * The two indexes are counted over the run rather than stored, because
         * a matrix of four is four rows under one `job_id` and their position
         * order *is* the expansion order. Actions numbers them from zero, and a
         * workflow that shards by `strategy.job-index` breaks quietly if this
         * counts differently.
         */
        strategy: {
          fail_fast: jobRow?.fail_fast !== false,
          max_parallel: jobRow?.max_parallel === null || jobRow?.max_parallel === undefined
            ? null
            : Number(jobRow.max_parallel),
          job_index: Math.max(0, siblings.findIndex(row => Number(row.id) === Number(claimed.jobId))),
          job_total: siblings.length,
        },
        parallel: jobRow?.parallel_total
          ? { index: Number(jobRow.parallel_index ?? 0), total: Number(jobRow.parallel_total) }
          : null,
        /*
         * What to collect when this job ends, whether it passed or failed.
         *
         * Sent as the globs the file wrote rather than as a resolved list: the
         * files do not exist yet, and only the machine that ran the job can say
         * what matched.
         */
        artifact_paths: artifactPathsOfJob(jobRow?.settings),
        /*
         * What to put in the workspace, and how much of it. Null when the job
         * said nothing, which is the whole history and everything in it - the
         * behaviour every workflow written before this key had.
         */
        checkout: checkoutOfJob(jobRow?.settings),
        /*
         * `vars`, resolved across the four levels at claim time.
         *
         * Resolved here rather than sent as four sets for the runner to merge:
         * a precedence rule implemented twice is a precedence rule that
         * disagrees with itself, and the screen that says where a value came
         * from reads the same resolution this does.
         *
         * Variables, never secrets. They go to every job including a fork's,
         * they are in the logs, and there is no secret store here to confuse
         * them with.
         */
        vars: await variablesFor(claimed.repositoryId, readJson(definitionJob?.env) as Record<string, string> ?? {}),
        /*
         * `secrets`, decided here and nowhere else.
         *
         * This is the last point at which both facts are known: whether the
         * run is trusted - a fork's pull request gets none, by the threat
         * model - and whether this job's environment gate has opened, which is
         * what makes "a deploy credential is released only after protection
         * passes" true rather than promised.
         *
         * A build or test job in the same run gets the repository's secrets
         * and not the environment's, which is the whole reason environment
         * secrets exist.
         */
        secrets: await secretsForJob({
          repositoryId: claimed.repositoryId,
          trusted: Boolean(context?.trusted),
          /*
           * The pool that took this job, so a secret set on those machines
           * reaches it. Known only here: which pool a job lands on is decided
           * by whichever runner claims it, which is why a pool secret cannot
           * appear in a repository's own listing.
           */
          poolId: claimed.poolId ?? null,
          environment: environmentOfJob(jobRow?.settings),
          approved: Boolean(jobRow?.approved_at),
          /*
           * What this job asked for, when it asked.
           *
           * Null - the job said nothing - keeps the old behaviour of every
           * secret in scope, which is what Actions does and what every existing
           * workflow expects. A job that names them gets those and no others,
           * so a compromised dependency in a test job cannot read the deploy
           * key that job never needed.
           */
          only: secretNamesOfJob(jobRow?.settings),
          /*
           * The automatic token joins the secrets rather than sitting beside
           * them, which buys two things for free: `${{ secrets.GITHUB_TOKEN }}`
           * works the way every workflow already expects, and the value is
           * masked in the log by the same pass that masks every other secret.
           */
          extra: minted ? { GITHUB_TOKEN: minted.token, REVIEWOS_JOB_TOKEN: minted.token } : {},
        }),
        /*
         * The event, in the shape a webhook receiver would have got.
         *
         * Written to a file by the runner and pointed at by
         * `GITHUB_EVENT_PATH`, because half the ecosystem reads the payload
         * rather than the environment - and an action that finds an empty file
         * there does nothing and says nothing, which is the shape of
         * compatibility that looks present and is not.
         */
        event: eventPayload({
          event: String(context?.event ?? ''),
          ref: refOf(context),
          sha: String(context?.head_sha ?? ''),
          runId: claimed.runId,
          runNumber: Number(context?.run_number ?? 0),
          repository: {
            full_name: context ? `${await ownerHandleOf(context)}/${context.repository}` : '',
            name: String(context?.repository ?? ''),
            owner: context ? await ownerHandleOf(context) : '',
            visibility: String(context?.visibility ?? ''),
            default_branch: String(context?.default_branch ?? ''),
          },
          sender: actor ? { handle: String(actor.handle), name: actor.name ? String(actor.name) : null } : null,
          pullRequest: pull
            ? {
                number: Number(pull.number),
                title: String(pull.title ?? ''),
                state: String(pull.state ?? ''),
                draft: pull.draft === true,
                head_ref: String(pull.head_ref ?? ''),
                base_ref: String(pull.base_ref ?? ''),
                head_sha: String(pull.head_sha ?? ''),
              }
            : null,
          inputs: readJson(context?.dispatch_inputs) as Record<string, unknown> | null,
          subject: subjectOf(String(context?.event_ref ?? '')),
        }),
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
        steps: runnerSteps,
        /*
         * The signature over those steps, and whether this pool insists on one.
         *
         * Both travel with the work rather than being fetched: the runner has
         * to decide before the first command, and a check it makes a second
         * request for is a check a broken network turns into a shrug.
         */
        signature,
        require_signed_steps: claimed.requireSignedSteps,
        /*
         * The plugins this job runs with, as scripts rather than references:
         * the machine is not asked to fetch anything, which keeps "what ran"
         * a question this instance can answer from the row it stored.
         */
        plugins,
      },
    })
  },
})

/** A job's `checkout:` options, out of its settings column. Null when it named none. */
function checkoutOfJob(settings: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return parsed?.checkout && typeof parsed.checkout === 'object' ? parsed.checkout : null
  }
  catch {
    // Unreadable settings mean the default checkout, which is the one that
    // works for every job rather than the one that skips the code.
    return null
  }
}

/**
 * The secrets a job asked for, out of its settings column.
 *
 * `null` when it named none, which is not the same as `[]`. Unreadable settings
 * also mean `null` rather than `[]`: a job that suddenly receives no secrets
 * because a JSON blob would not parse fails in a way nobody can diagnose from
 * the run page, where the same job receiving what it always did is at worst the
 * status quo.
 */
function secretNamesOfJob(settings: unknown): string[] | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return Array.isArray(parsed?.secrets) ? parsed.secrets.map(String) : null
  }
  catch {
    return null
  }
}

/**
 * The globs a job asked to have collected, out of its settings column.
 *
 * An empty list when the settings cannot be read, which is the safe direction:
 * a job that uploads nothing is a job somebody notices, and one that uploads
 * whatever a corrupt blob happened to decode to is not.
 */
function artifactPathsOfJob(settings: unknown): string[] {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return Array.isArray(parsed?.artifactPaths) ? parsed.artifactPaths.map(String) : []
  }
  catch {
    return []
  }
}

/** The environment a job named, out of its settings column. */
function environmentOfJob(settings: unknown): string | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return parsed && typeof parsed === 'object' && typeof parsed.environment === 'string' ? parsed.environment : null
  }
  catch {
    return null
  }
}
