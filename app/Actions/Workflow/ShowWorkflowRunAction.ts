import { Action } from '@stacksjs/actions'
import { explainEnv } from './env'
import { splitLabels } from '../Runner/protocol'
import { defaultsOf, resolveDefaults } from './defaults'
import { explainWaiting } from './waiting'
import { resolvePermissions } from './permissions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * One run, with its jobs and their steps.
 *
 * Returned whole rather than as three endpoints a client has to stitch. A run
 * is small - tens of jobs, tens of steps - and the screen that shows one needs
 * all of it, so three round trips would buy nothing but a chance for the three
 * to disagree about what state the run was in.
 *
 * Addressed by the run's **number**, which is what a person says out loud and
 * what a link carries, rather than by its database id.
 */
/**
 * The environment a job's steps inherit, with each value's origin.
 *
 * Workflow level then job level; the step level is applied when the step runs
 * and is deliberately not folded in here, because a job's answer has to be one
 * answer rather than one per step.
 */
function envFor(job: any, definitionJobs: readonly any[], version: any): any[] {
  const definition = definitionJobs.find(row => String(row.job_id) === String(job.job_id))

  return explainEnv({
    workflow: version?.env ?? null,
    job: definition?.env ?? null,
  }).map(entry => ({
    name: entry.name,
    value: entry.value,
    from: entry.level,
    overrides: entry.overridden,
  }))
}

/** Why a queued job has not been picked up, in the shape a screen can render. */
function waitingFor(job: any, repositoryId: number, ownerId: number, runners: any[]): any {
  const explained = explainWaiting(
    {
      id: Number(job.id),
      state: String(job.state),
      runsOn: String(job.runs_on ?? '').split('\n').map(line => line.trim()).filter(Boolean),
      repositoryId,
      ownerId,
      runnerId: job.runner_id === null ? null : Number(job.runner_id),
      leaseExpiresAt: job.lease_expires_at ?? null,
    },
    runners,
  )

  return {
    kind: explained.kind,
    summary: explained.summary,
    wanted: explained.wanted,
    available: explained.available,
  }
}

/** What this job's token may do, with the level of the file that decided it. */
function permissionsFor(job: any, definitionJobs: readonly any[], version: any): any {
  const definition = definitionJobs.find(row => String(row.job_id) === String(job.job_id))
  const resolved = resolvePermissions(version?.permissions ?? null, definition?.permissions ?? null)

  return {
    scopes: resolved.granted,
    from: resolved.source,
    unsupported: resolved.unsupported,
  }
}

export default new Action({
  name: 'ShowWorkflowRun',
  description: 'Get one workflow run, with its jobs and steps',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  responses: {
    200: {
      description: 'One run, its jobs and their steps, plus the workflow version it ran - so a reader can tell it from the file as it is today.',
      schema: {
        type: 'object',
        properties: {
          workflow_run: { type: 'object' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such repository, or no run with that number.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select([
        'id', 'job_id', 'name', 'position', 'state', 'needs',
        'runs_on', 'runner_id', 'queued_at', 'started_at', 'finished_at',
        // Where this attempt was told to begin, so a client can say why the
        // first steps of a job show a result nothing on this attempt produced.
        'resume_from_step',
        // Whether the cache did anything for this job, as the pair rather than
        // the ratio: the ratio is derived, and a stored one disagrees with it.
        'cache_lookups', 'cache_hits',
      ])
      .where('workflow_run_id', '=', Number(run.id))
      .orderBy('position')
      .execute()

    // One query for every step in the run rather than one per job: a run with
    // forty jobs is forty round trips otherwise, for a page that shows them
    // all at once.
    const steps = jobs.length > 0
      ? await db
        .selectFrom('workflow_steps')
        .select(['id', 'workflow_job_id', 'position', 'name', 'state', 'attempts', 'exit_code', 'started_at', 'finished_at', 'reused_from_attempt', 'error'])
        .where('workflow_job_id', 'in', jobs.map(job => Number(job.id)))
        .orderBy('position')
        .execute()
      : []

    /*
     * The definition's jobs, for the `env` each one declared. One query, keyed
     * by the job id the run copied, because a run's job carries its name and
     * state but not the file's environment.
     */
    /*
     * The runners this instance has, for explaining why a queued job is still
     * queued. One query for the whole run rather than one per job: a fleet is
     * tens of rows and a run can be tens of jobs.
     *
     * Only read when something is actually waiting - a finished run has nothing
     * to explain, and a query per page view for a screen nobody is puzzled by
     * is a query nobody asked for.
     */
    const waiting = jobs.some(job => String(job.state) === 'queued' || String(job.state) === 'blocked')

    const runners: any[] = waiting
      ? await db.selectFrom('runners').select(['id', 'state', 'scope_type', 'scope_id', 'labels']).execute()
      : []

    const runnerFacts = runners.map(runner => ({
      id: Number(runner.id),
      state: String(runner.state),
      scopeType: String(runner.scope_type),
      scopeId: runner.scope_id === null ? null : Number(runner.scope_id),
      labels: splitLabels(runner.labels),
    }))

    const definitionJobs = await db
      .selectFrom('workflow_version_jobs')
      .select(['job_id', 'env', 'permissions', 'default_shell', 'default_working_directory'])
      .where('workflow_version_id', '=', Number(run.workflow_version_id))
      .execute()

    const byJob = new Map<number, any[]>()
    for (const step of steps as any[]) {
      const jobId = Number(step.workflow_job_id)
      byJob.set(jobId, [...(byJob.get(jobId) ?? []), step])
    }

    const version = await db
      .selectFrom('workflow_versions')
      .select([
        'id', 'workflow_id', 'source_path', 'source_sha', 'content_digest',
        'env', 'permissions', 'default_shell', 'default_working_directory',
      ])
      .where('id', '=', Number(run.workflow_version_id))
      .executeTakeFirst()

    const workflow: any = version
      ? await db
        .selectFrom('workflows')
        // `repository_id` too: null means the definition is the owner's rather
        // than this repository's, which changes what the run was given and is
        // the first thing somebody reading it should be told.
        .select(['id', 'name', 'path', 'repository_id'])
        .where('id', '=', Number(version.workflow_id))
        .executeTakeFirst()
      : null

    return response.json({
      workflow_run: {
        id: Number(run.id),
        number: Number(run.number),
        state: String(run.state),
        event: String(run.event),
        ref: run.event_ref ?? null,
        head_sha: run.head_sha ?? null,
        definition_sha: run.definition_sha ?? null,
        trusted: Boolean(run.trusted),
        started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null,
        /**
         * When somebody held this run, when somebody did.
         *
         * Beside the state rather than folded into it: `paused` is also what a
         * run holding at a gate says, and a client that cannot tell those apart
         * would offer to resume a run nobody held.
         */
        paused_at: run.paused_at ?? null,
        /**
         * The caller's own id for the request that started this run, when an
         * API call started it. Null for a push, which nobody called.
         */
        request_id: run.request_id ?? null,
        reason: run.conclusion_reason ?? null,
        created_at: run.created_at ?? null,

        workflow: workflow
          ? {
              id: Number(workflow.id),
              name: String(workflow.name),
              path: workflow.path ?? null,
              /**
               * Whether this definition belongs to the owner rather than to the
               * repository.
               *
               * An owner-wide workflow runs over this repository's data at the
               * owner's trust level, and is given the owner's secrets and none
               * of this repository's. A reader who cannot see that cannot tell
               * why a run has a credential their repository never configured.
               */
              owner_defined: workflow.repository_id === null || workflow.repository_id === undefined,
            }
          : null,

        // The version, so a reader can tell which definition this ran and
        // whether it is the one in the branch today.
        version: version
          ? {
              id: Number(version.id),
              path: version.source_path ?? null,
              sha: version.source_sha ?? null,
              digest: version.content_digest ?? null,
            }
          : null,

        jobs: jobs.map(job => ({
          id: Number(job.id),
          job_id: String(job.job_id),
          /*
           * The environment this job's steps see, and where each value came
           * from.
           *
           * Answering "why did my step see staging when the job says
           * production" is the reason this is here rather than only in the
           * runner: the three levels merge by name, so the effective value is
           * not readable from the file without doing the merge by hand.
           *
           * Definition-level only. A step's own `env` is applied on top when
           * the step runs, and secrets are never in this: they are resolved at
           * injection time, after the fork check, and never written to a row.
           */
          env: envFor(job, definitionJobs, version),
          /*
           * What this job's token would be allowed to do, and how that was
           * decided.
           *
           * Worth returning even though nothing mints a token yet: a workflow
           * that expected to write issues and gets `contents: read` fails at
           * the far end with an error about permissions, and this is where a
           * person looks to find out why. `unsupported` is the other half -
           * a permission this instance has no scope for is named rather than
           * dropped.
           *
           * A fork's pull request is a separate question, decided at injection
           * time by the run's `trusted` column, not here.
           */
          permissions: permissionsFor(job, definitionJobs, version),
          /*
           * Why this job has not started, when it has not.
           *
           * A run sitting at "queued" with nothing else on the screen is the
           * most expensive page in a forge: it looks like the instance is
           * thinking, so people wait, and the instance knew the answer the
           * whole time - no runner has `macos-14`, or the only one that
           * matches was switched off this morning.
           */
          waiting: String(job.state) === 'queued'
            ? waitingFor(job, Number(run.repository_id), Number(repository.owner_id ?? 0), runnerFacts)
            : null,
          name: job.name ?? null,
          state: String(job.state),
          needs: String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean),
          runs_on: String(job.runs_on ?? '').split('\n').map(line => line.trim()).filter(Boolean),
          runner: job.runner_id ?? null,
          /*
           * Three timestamps, not two.
           *
           * `queued_at` is when a runner could first have taken this job, so
           * the gap to `started_at` is the wait for a machine and the gap after
           * it is the work. A client given only two cannot tell a slow job from
           * a job that could not get a machine, which is the first thing anyone
           * asks about a slow run.
           */
          queued_at: job.queued_at ?? null,
          started_at: job.started_at ?? null,
          finished_at: job.finished_at ?? null,
          /**
           * The step this attempt starts at, counting from zero, or null for
           * the beginning. Only a restart-from-step sets it.
           */
          resume_from_step: job.resume_from_step === null || job.resume_from_step === undefined
            ? null
            : Number(job.resume_from_step),
          /**
           * How many cache lookups this job made and how many found something.
           *
           * Both, so a client can say "two of five" - which is the answer that
           * points at a key that changes too often, where a percentage points
           * at nothing.
           */
          cache: {
            lookups: Number(job.cache_lookups ?? 0),
            hits: Number(job.cache_hits ?? 0),
          },
          /*
           * What this job's steps run with when they say nothing themselves.
           *
           * `null` means the runner decides, which is a real answer: the shell
           * depends on the platform, and inventing one here would be a default
           * the file never asked for and impossible to tell from one it did.
           */
          defaults: (() => {
            const definition = definitionJobs.find(row => String(row.job_id) === String(job.job_id))
            const resolved = resolveDefaults({ workflow: defaultsOf(version), job: defaultsOf(definition) })

            return {
              shell: resolved.shell,
              shell_from: resolved.shellFrom,
              working_directory: resolved.workingDirectory,
              working_directory_from: resolved.workingDirectoryFrom,
            }
          })(),
          steps: (byJob.get(Number(job.id)) ?? []).map(step => ({
            id: Number(step.id),
            name: step.name ?? null,
            state: String(step.state),
            attempts: Number(step.attempts ?? 0),
            exit_code: step.exit_code ?? null,
            started_at: step.started_at ?? null,
            finished_at: step.finished_at ?? null,
            /**
             * Why it failed, when it did. A number says a command refused and
             * a sentence says which one - a client with only the first sends
             * somebody into a log to find the second.
             */
            error: step.error ?? null,
            /*
             * The attempt that actually did this work, when it was not this
             * one. Null on a step this attempt ran itself.
             *
             * Said in the API and not only on the screen, because a client
             * comparing two attempts' timings would otherwise read a kept
             * nine-minute result as nine minutes this attempt spent.
             */
            reused_from_attempt: step.reused_from_attempt === null || step.reused_from_attempt === undefined
              ? null
              : Number(step.reused_from_attempt),
          })),
        })),
      },
    })
  },
})
