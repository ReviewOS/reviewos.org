import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { isTrue } from '../Support/sql'

/**
 * One workflow, its versions, and what a version actually says.
 *
 * Three questions a client had no way to ask: which definitions has this
 * workflow had, which one is live, and what does it *mean* - the jobs, what
 * each waits on, and what kind of thing each one is.
 *
 * **The graph is normalized rather than the file re-served.** Handing back YAML
 * would make every client parse a format whose meaning lives here - the
 * `needs:` a barrier inserts, the kind a `reviewos:` key decides, the matrix
 * that turns one job into four. Two parsers is how a client's picture of a run
 * stops matching the run.
 *
 * The version is addressed by id and the workflow by path or name, because
 * those are what a person has: a path is what they typed into a file, and an id
 * is what a previous answer handed them.
 */
export default new Action({
  name: 'ShowWorkflow',
  description: 'Get one workflow, its versions, and a version\'s normalized graph',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    /** The workflow, by path or by name. */
    workflow: { rule: schema.string() },
    /** Which version to describe. The newest, unless one is named. */
    version: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The workflow, every version it has had, and the named version\'s normalized graph.',
      schema: {
        type: 'object',
        properties: {
          workflow: { type: 'object' },
          versions: { type: 'array', items: { type: 'object' } },
          version: { type: 'object', description: 'The one described, with its triggers and its graph.' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such workflow in this repository, or no version by that id.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const wanted = String(request.get('workflow') ?? '').trim()

    if (!wanted)
      return response.json({ error: 'A workflow is required: its path, or its name' }, 422)

    const candidates = await db
      .selectFrom('workflows')
      .select(['id', 'name', 'path', 'state', 'last_scheduled_at', 'created_at'])
      .where('repository_id', '=', repository.id)
      .execute()

    /*
     * Path first, then a suffix, then the name - the same resolution the
     * dispatch endpoint uses, because a client that can start a workflow by
     * name and cannot read it by name has two vocabularies for one thing.
     */
    const workflow = candidates.find(row => String(row.path) === wanted)
      ?? candidates.find(row => String(row.path).endsWith(`/${wanted}`))
      ?? candidates.find(row => String(row.name) === wanted)

    if (!workflow)
      return response.json({ error: 'No such workflow' }, 404)

    const versions = await db
      .selectFrom('workflow_versions')
      .select(['id', 'source_sha', 'source_path', 'content_digest', 'created_at'])
      .where('workflow_id', '=', Number(workflow.id))
      .orderBy('id', 'desc')
      .limit(50)
      .execute()

    const asked = Number(request.get('version'))

    const chosen = Number.isInteger(asked) && asked > 0
      ? versions.find(row => Number(row.id) === asked)
      : versions[0]

    if (Number.isInteger(asked) && asked > 0 && !chosen)
      return response.json({ error: 'No such version of this workflow' }, 404)

    const detail = chosen
      ? await db
        .selectFrom('workflow_versions')
        .selectAll()
        .where('id', '=', Number(chosen.id))
        .executeTakeFirst()
      : null

    const jobs = chosen
      ? await db
        .selectFrom('workflow_version_jobs')
        .select(['id', 'job_id', 'name', 'position', 'needs', 'runs_on', 'kind', 'settings', 'env', 'permissions', 'matrix', 'timeout_minutes', 'condition'])
        .where('workflow_version_id', '=', Number(chosen.id))
        .orderBy('position')
        .execute()
        .catch(() => [])
      : []

    const steps = jobs.length > 0
      ? await db
        .selectFrom('workflow_version_steps')
        .select(['workflow_version_job_id', 'position', 'name', 'command', 'uses', 'step_id', 'condition', 'continue_on_error', 'timeout_minutes'])
        .where('workflow_version_job_id', 'in', jobs.map(job => Number(job.id)))
        .orderBy('position')
        .execute()
        .catch(() => [])
      : []

    const byJob = new Map<number, any[]>()

    for (const step of steps as any[]) {
      const jobId = Number(step.workflow_version_job_id)

      byJob.set(jobId, [...(byJob.get(jobId) ?? []), step])
    }

    return response.json({
      workflow: {
        id: Number(workflow.id),
        name: workflow.name ?? null,
        path: workflow.path ?? null,
        state: String(workflow.state),
        last_scheduled_at: workflow.last_scheduled_at ?? null,
        created_at: workflow.created_at ?? null,
      },

      versions: versions.map(row => ({
        id: Number(row.id),
        sha: row.source_sha ?? null,
        path: row.source_path ?? null,
        digest: row.content_digest ?? null,
        created_at: row.created_at ?? null,
        /** Whether this is the definition a push would run today. */
        current: Number(row.id) === Number(versions[0]?.id ?? 0),
      })),

      version: chosen
        ? {
            id: Number(chosen.id),
            sha: chosen.source_sha ?? null,
            path: chosen.source_path ?? null,
            digest: chosen.content_digest ?? null,

            /*
             * What starts it, as flags rather than as the `on:` block.
             *
             * The parser has already decided what `on: [push, pull_request]`
             * and `on: { push: { branches: [main] } }` both mean, and handing
             * back either spelling would leave a client re-deciding it.
             */
            triggers: {
              push: isTrue(detail?.on_push),
              pull_request: isTrue(detail?.on_pull_request),
              pull_request_target: isTrue(detail?.on_pull_request_target),
              dispatch: isTrue(detail?.on_dispatch),
              issues: isTrue(detail?.on_issues),
              issue_comment: isTrue(detail?.on_issue_comment),
              release: isTrue(detail?.on_release),
              repository_dispatch: isTrue(detail?.on_repository_dispatch),
              workflow_run: isTrue(detail?.on_workflow_run),
              reusable: isTrue(detail?.reusable),
              schedules: lines(detail?.schedules),
              branches: lines(detail?.push_branches),
              paths: lines(detail?.push_paths),
              tags: lines(detail?.push_tags),
            },

            /** What the parser could not act on, which is worth saying out loud. */
            warnings: lines(detail?.warnings),
            unsupported_events: lines(detail?.unsupported_events),

            /*
             * The graph, as the dispatcher will build it.
             *
             * `needs` is a list rather than the newline-joined column, because
             * the column's shape is a storage decision and a client repeating
             * it would be a client that breaks when it changes.
             */
            jobs: jobs.map(job => ({
              id: Number(job.id),
              key: String(job.job_id),
              name: job.name ?? null,
              position: Number(job.position ?? 0),
              kind: String(job.kind ?? 'command'),
              needs: lines(job.needs),
              runs_on: lines(job.runs_on),
              condition: job.condition ?? null,
              timeout_minutes: job.timeout_minutes === null || job.timeout_minutes === undefined
                ? null
                : Number(job.timeout_minutes),
              matrix: readJson(job.matrix),
              settings: readJson(job.settings),
              steps: (byJob.get(Number(job.id)) ?? []).map(step => ({
                position: Number(step.position ?? 0),
                name: step.name ?? null,
                id: step.step_id ?? null,
                run: step.command ?? null,
                uses: step.uses ?? null,
                condition: step.condition ?? null,
                continue_on_error: isTrue(step.continue_on_error),
                timeout_minutes: step.timeout_minutes === null || step.timeout_minutes === undefined
                  ? null
                  : Number(step.timeout_minutes),
              })),
            })),
          }
        : null,
    })
  },
})

/** A newline-joined column, as the list it stands for. */
function lines(value: unknown): string[] {
  return String(value ?? '')
    .split('\n')
    .map(one => one.trim())
    .filter(Boolean)
}

/** A JSON column, or null when there is nothing readable in it. */
function readJson(value: unknown): unknown {
  if (value === null || value === undefined || String(value).trim() === '')
    return null

  try {
    return JSON.parse(String(value))
  }
  catch {
    return null
  }
}
