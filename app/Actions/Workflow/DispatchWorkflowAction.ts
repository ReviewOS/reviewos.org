import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
import { resolveGroup } from './concurrency'
import { checkInputs } from './inputs'
import { dispatchKey, withRedeliveryKey } from './redelivery'
import { requestIdOf } from '../../Api/correlation'
import { isTrue } from '../Support/sql'

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
    /**
     * A caller-supplied key that makes this request produce at most one run.
     *
     * Optional, because a dispatch is a repeatable event by design: a nightly
     * job runs at the same ref every night, and pressing the button twice on
     * purpose is the feature. A caller that names a key is saying something
     * narrower - *this* request, however many times the network makes them
     * send it.
     */
    key: { rule: schema.string(), required: false },
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
              request_id: { type: 'string', description: 'The caller\'s `X-Request-Id`, or the one minted for them. It travels to the machine that runs the job.' },
            },
          },
        },
      },
    },
    303: { description: 'A browser gets the run list back. The same action serves the interface, so it answers HTML callers with a redirect.' },
    ...REPOSITORY_ERRORS,
    409: { description: 'The workflow does not accept `workflow_dispatch`.' },
    422: { description: 'The inputs do not match what the workflow declared. Every problem is listed, not just the first.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
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
    const candidates = await db
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

    const version = await db
      .selectFrom('workflow_versions')
      .select(['id', 'on_dispatch', 'dispatch_inputs', 'source_sha', 'concurrency_group', 'cancel_in_progress'])
      .where('workflow_id', '=', Number(workflow.id))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()

    if (!version)
      return response.json({ error: 'This workflow has no readable version' }, 404)

    if (!isTrue(version.on_dispatch)) {
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

    /*
     * The caller's key, and the run it already made.
     *
     * Checked before the insert as well as being enforced by the index, so a
     * repeat gets the run rather than an error: a client retrying a request it
     * did not hear the answer to wants the answer, not a conflict it has to
     * write a branch for. The index is still what makes it true when two
     * arrive together.
     */
    const idempotency = dispatchKey(Number(repository.id), String(request.get('key') ?? ''))

    if (idempotency) {
      const already = await db
        .selectFrom('workflow_runs')
        .select(['id', 'number', 'state'])
        .where('repository_id', '=', Number(repository.id))
        .where('redelivery_key', '=', idempotency)
        .executeTakeFirst()
        .catch(() => null)

      if (already) {
        return response.json({
          workflow_run: { id: Number(already.id), number: Number(already.number), state: String(already.state) },
          duplicate: true,
        })
      }
    }

    /*
     * The caller's own id for this request, kept if they sent one.
     *
     * It goes onto the run and out to the machine in the claim, so "a program
     * of ours called your API and something odd happened" is a question with an
     * answer - rather than one reconstructed from timestamps on an instance
     * where three deploy bots dispatch the same workflow every few minutes.
     */
    const correlation = requestIdOf(request as any)

    const number = await nextNumber(Number(repository.id))

    const runId = await startRunFor({
      values: {
        ...withRedeliveryKey({
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
          // The values that were actually used, defaults filled in - not what
          // was typed. A person reading the run later needs to know what it ran
          // with.
          dispatch_inputs: Object.keys(checked.values).length > 0 ? JSON.stringify(checked.values) : null,
        }),
        /*
         * And the caller's key in the column the index is on, over the null a
         * dispatch would otherwise carry.
         *
         * A dispatch is repeatable on purpose, which is why it has no key of
         * its own; a caller that supplies one is opting this request out of
         * that, and the enforcement should be the same index rather than a
         * second mechanism that has to agree with it.
         */
        ...(idempotency ? { redelivery_key: idempotency } : {}),
        request_id: correlation,
      },
      versionId: Number(version.id),
      repositoryId: Number(repository.id),
      idempotency,
    })

    /*
     * Recorded, because starting a run spends the instance's machines and can
     * reach whatever they reach. `auditFrom` carries the token as well as the
     * person: a run started by a program is the case where "who did this" has
     * no other answer.
     */
    await auditEvent('workflow:run-dispatched', {
      subject: { type: 'workflow_run', id: runId },
      actorId: auth.context.user?.id ?? null,
      ...await auditFrom(request),
      repositoryId: Number(repository.id),
      detail: { workflow: String(workflow.path), number, ref, inputs: checked.values },
    }).catch(() => null)

    /*
     * A browser gets the run list back; a program gets the row.
     *
     * The workflows screen posts an ordinary form here rather than to a route
     * of its own, for the reason `CancelWorkflowRunAction` gives: a control the
     * interface has and the API does not is a second, undocumented way to
     * change the instance's state. Without the redirect the reader lands on a
     * page of JSON, which is a working feature that looks broken.
     */
    if (wantsHtml(request)) {
      const owner = String(request.get('owner') ?? '')

      return response.redirect(`/${owner}/${String(repository.name)}/runs`)
    }

    return response.json({
      workflow_run: {
        number,
        state: 'queued',
        event: 'workflow_dispatch',
        inputs: checked.values,
        /**
         * The id this run is known by, echoed so a caller that sent none can
         * still write it down beside their own log line.
         */
        request_id: correlation,
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
function suppliedFrom(request: RequestInstance): Record<string, unknown> {
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
  const row = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  return Number(row?.number ?? 0) + 1
}

/**
 * The run and its jobs, copied from the definition, matrix and all.
 *
 * Shares `dispatchPush`'s helper rather than reimplementing the copy: a second
 * version of this would be a second place for the matrix fan-out to be wrong,
 * and - since that helper writes the run and its graph in one transaction - a
 * second place for a half-written run to become visible.
 *
 * ## Losing the race for an idempotency key
 *
 * The insert can fail on the unique index, which is the failure it is there to
 * have: two retries of one request arriving together, where the winner's run is
 * the answer both of them wanted. The loser returns the winner's id and writes
 * nothing.
 *
 * It used to return that id and then build a graph on it, which put a *second*
 * copy of every job on somebody else's run - the retry of a dispatch quietly
 * doubling the pipeline. Now that the graph is written in the same transaction
 * as the run, the loser has nothing left to do: the winner's transaction either
 * committed a complete run or rolled the whole thing back.
 *
 * Only a collision is read this way. The old shape caught *any* failure of the
 * insert and went looking for a winner, which was survivable while the call
 * wrote one row; this one covers the graph and the first settle as well, and
 * treating a failure in either as "somebody else got there first" would hand
 * back a run id and say nothing about what actually broke.
 */
async function startRunFor(input: {
  values: Record<string, unknown>
  versionId: number
  repositoryId: number
  idempotency: string | null
}): Promise<number> {
  const { isDuplicate, startRun } = await import('./dispatch')

  try {
    return await startRun({ values: input.values, versionId: input.versionId })
  }
  catch (error) {
    if (!input.idempotency || !isDuplicate(error))
      throw error

    const winner: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', input.repositoryId)
      .where('redelivery_key', '=', input.idempotency)
      .executeTakeFirst()

    // No winner means this was not the collision the key is for, and the caller
    // deserves the original failure rather than a run id of zero.
    if (!winner)
      throw error

    return Number(winner.id)
  }
}
