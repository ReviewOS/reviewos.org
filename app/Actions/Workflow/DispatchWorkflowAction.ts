import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { resolveGroup } from './concurrency'
import { checkInputs } from './inputs'

/**
 * Start a workflow by hand.
 *
 * `workflow_dispatch` is the trigger with no event behind it: somebody, or a
 * program with a token, decides a run should happen. It was stored on every
 * version and there was no way to act on it, so the only workflows this
 * instance could run were ones an event happened to.
 *
 * **The inputs are checked against what the workflow declared**, and that is
 * most of the value here. "The workflow says `choice: [staging, production]`
 * and you sent `producton`" has to be a message now, not a run that fails
 * twelve minutes later on a typo - and an input the workflow never declared is
 * refused rather than dropped, because silently discarding one is how somebody
 * spends an afternoon wondering why `enviroment: production` did nothing.
 *
 * Write access, not read. Starting a run spends the instance's runners and can
 * touch anything the workflow can touch; anybody who may see a workflow is not
 * therefore somebody who may run it.
 */
export default new Action({
  name: 'DispatchWorkflow',
  description: 'Start a workflow run by hand',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    workflow: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  responses: {
    201: {
      description: 'The run that was created.',
      schema: {
        type: 'object',
        properties: {
          workflow_run: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              state: { type: 'string' },
              event: { type: 'string' },
              inputs: { type: 'object' },
            },
          },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    409: { description: 'The workflow does not accept `workflow_dispatch`.' },
    422: { description: 'The inputs do not match what the workflow declared. Every problem is listed, not just the first.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'workflow:dispatch')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const wanted = String(request.get('workflow') ?? '').trim()
    if (!wanted)
      return response.json({ error: 'A workflow is required' }, 422)

    /*
     * Named by path or by name, because both are what somebody has to hand:
     * the path is what the API caller knows and the name is what the interface
     * shows. `ci.yml` is accepted as well as the full path, since that is what
     * people type.
     */
    /*
     * Matched here rather than in SQL. This query builder's expression callback
     * does not take the callable form, and a repository has a handful of
     * workflows - the alternative is three round trips to answer one question.
     *
     * Exact path first, then the file name, then the workflow's name: two
     * workflows can share a name, and the path is the thing that is unique.
     */
    const candidates: any[] = await db
      .selectFrom('workflows')
      .select(['id', 'name', 'path', 'state'])
      .where('repository_id', '=', repository.id)
      .execute()

    const workflow = candidates.find(row => String(row.path) === wanted)
      ?? candidates.find(row => String(row.path).endsWith(`/${wanted}`))
      ?? candidates.find(row => String(row.name) === wanted)

    if (!workflow)
      return response.json({ error: 'No such workflow' }, 404)

    if (String(workflow.state) !== 'active') {
      // A disabled workflow refusing to run by hand is the point of disabling
      // it, and a removed one has no file to run.
      return response.json({
        error: `This workflow is ${workflow.state} and cannot be dispatched`,
      }, 409)
    }

    const version: any = await db
      .selectFrom('workflow_versions')
      .select(['id', 'on_dispatch', 'dispatch_inputs', 'source_sha', 'concurrency_group', 'cancel_in_progress'])
      .where('workflow_id', '=', Number(workflow.id))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()

    if (!version)
      return response.json({ error: 'This workflow has no readable version' }, 404)

    if (version.on_dispatch !== true) {
      return response.json({
        error: 'This workflow does not accept workflow_dispatch. Add it to the workflow\'s `on:` to run it by hand.',
      }, 409)
    }

    const declared = parseDeclared(version.dispatch_inputs)
    const supplied = suppliedFrom(request)
    const checked = checkInputs(declared, supplied)

    if (!checked.ok) {
      // Every problem, not the first: a form with three wrong fields should be
      // fixable in one pass rather than three round trips.
      return response.json({ error: 'These inputs do not match the workflow', problems: checked.errors }, 422)
    }

    const ref = String(request.get('ref') ?? '').trim() || `refs/heads/${repository.default_branch ?? 'main'}`
    const sha = String(version.source_sha ?? '')

    const group = resolveGroup(version.concurrency_group, {
      workflow: String(workflow.name || workflow.path || ''),
      eventName: 'workflow_dispatch',
      ref,
      sha,
    })

    const number = await nextNumber(Number(repository.id))

    const run: any = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: Number(version.id),
        repository_id: Number(repository.id),
        number,
        state: 'queued',
        event: 'workflow_dispatch',
        event_ref: ref,
        head_sha: sha,
        definition_sha: sha,
        /*
         * Trusted: whoever asked has write access to this repository, and the
         * workflow is the one the repository has registered. This is not the
         * fork path - there is no untrusted tree involved.
         */
        trusted: true,
        actor_id: auth.context.user?.id ?? null,
        concurrency_group: group,
        // The values that were actually used, defaults filled in - not what was
        // typed. A person reading the run later needs to know what it ran with.
        dispatch_inputs: Object.keys(checked.values).length > 0 ? JSON.stringify(checked.values) : null,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    await createJobsFor(Number(run?.id), Number(version.id))

    return response.json({
      workflow_run: {
        number,
        state: 'queued',
        event: 'workflow_dispatch',
        inputs: checked.values,
      },
    }, 201)
  },
})

/** The inputs the version stored, or none when it stored nothing readable. */
function parseDeclared(stored: unknown): any[] {
  const text = String(stored ?? '').trim()

  if (!text)
    return []

  try {
    const parsed = JSON.parse(text)

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    // A version whose inputs cannot be read accepts none rather than refusing
    // the dispatch: the workflow still runs, which is what was asked for.
    return []
  }
}

/**
 * What the caller sent, from either shape.
 *
 * `inputs` as an object is what the API takes and what Actions documents; a
 * form posts `inputs[name]` instead, and the interface is a form.
 */
function suppliedFrom(request: any): Record<string, unknown> {
  const direct = request.get('inputs')

  if (direct && typeof direct === 'object' && !Array.isArray(direct))
    return direct as Record<string, unknown>

  if (typeof direct === 'string' && direct.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(direct)

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed
    }
    catch {
      // Fall through to the bracketed form below.
    }
  }

  const all = typeof request.all === 'function' ? request.all() : {}
  const values: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(all ?? {})) {
    const match = /^inputs\[(.+)\]$/.exec(key)

    if (match?.[1])
      values[match[1]] = value
  }

  return values
}

/** The next run number for this repository. Per repository, so "run 42" means one run. */
async function nextNumber(repositoryId: number): Promise<number> {
  const row: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  return Number(row?.number ?? 0) + 1
}

/**
 * The run's jobs, copied from the definition, matrix and all.
 *
 * Shares `dispatchPush`'s helper rather than reimplementing the copy: a second
 * version of this would be a second place for the matrix fan-out to be wrong.
 */
async function createJobsFor(runId: number, versionId: number): Promise<void> {
  const { createJobsForRun } = await import('./dispatch')

  await createJobsForRun(runId, versionId)
}
