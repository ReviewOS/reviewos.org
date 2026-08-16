import { Action } from '@stacksjs/actions'
import { explainEnv } from './env'
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

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const run: any = await db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const jobs: any[] = await db
      .selectFrom('workflow_jobs')
      .select([
        'id', 'job_id', 'name', 'position', 'state', 'needs',
        'runs_on', 'runner_id', 'started_at', 'finished_at',
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
        .select(['id', 'workflow_job_id', 'position', 'name', 'state', 'attempts', 'exit_code', 'started_at', 'finished_at'])
        .where('workflow_job_id', 'in', jobs.map(job => Number(job.id)))
        .orderBy('position')
        .execute()
      : []

    /*
     * The definition's jobs, for the `env` each one declared. One query, keyed
     * by the job id the run copied, because a run's job carries its name and
     * state but not the file's environment.
     */
    const definitionJobs: any[] = await db
      .selectFrom('workflow_version_jobs')
      .select(['job_id', 'env', 'permissions'])
      .where('workflow_version_id', '=', Number(run.workflow_version_id))
      .execute()

    const byJob = new Map<number, any[]>()
    for (const step of steps as any[]) {
      const jobId = Number(step.workflow_job_id)
      byJob.set(jobId, [...(byJob.get(jobId) ?? []), step])
    }

    const version: any = await db
      .selectFrom('workflow_versions')
      .select(['id', 'workflow_id', 'source_path', 'source_sha', 'content_digest', 'env', 'permissions'])
      .where('id', '=', Number(run.workflow_version_id))
      .executeTakeFirst()

    const workflow: any = version
      ? await db
        .selectFrom('workflows')
        .select(['id', 'name', 'path'])
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
        reason: run.conclusion_reason ?? null,
        created_at: run.created_at ?? null,

        workflow: workflow
          ? { id: Number(workflow.id), name: String(workflow.name), path: workflow.path ?? null }
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
          name: job.name ?? null,
          state: String(job.state),
          needs: String(job.needs ?? '').split('\n').map(line => line.trim()).filter(Boolean),
          runs_on: String(job.runs_on ?? '').split('\n').map(line => line.trim()).filter(Boolean),
          runner: job.runner_id ?? null,
          started_at: job.started_at ?? null,
          finished_at: job.finished_at ?? null,
          steps: (byJob.get(Number(job.id)) ?? []).map(step => ({
            id: Number(step.id),
            name: step.name ?? null,
            state: String(step.state),
            attempts: Number(step.attempts ?? 0),
            exit_code: step.exit_code ?? null,
            started_at: step.started_at ?? null,
            finished_at: step.finished_at ?? null,
          })),
        })),
      },
    })
  },
})
