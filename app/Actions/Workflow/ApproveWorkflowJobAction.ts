import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
import { environmentRules, mayApprove } from './environments'
import { settleRun } from './settle'

/**
 * Open a gate.
 *
 * A `block:` job is a run holding still until a person decides, which is what a
 * deployment approval actually is. Everything about it is deliberately
 * unglamorous: the job sits in `paused`, this records who opened it and what
 * they typed, and the graph moves on exactly as it would have if a machine had
 * finished a job.
 *
 * **Its own ability, `workflow:approve`.** Not `workflow:cancel`: stopping a
 * build is safe and approving a release is not, and folding them together would
 * mean anybody who can stop a run can also ship one.
 *
 * The fields the workflow declared become the job's **outputs**, so a later job
 * reads them as `needs.approve.outputs.version` - the same way it reads any
 * other job's outputs. Inventing a second mechanism for "values a human typed"
 * would be a second thing to learn for a value that behaves identically.
 */
export default new Action({
  name: 'ApproveWorkflowJob',
  description: 'Open a paused gate in a workflow run',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    job: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'The gate as it now stands, and the run\'s state after it.',
      schema: {
        type: 'object',
        properties: {
          job: { type: 'object', properties: { job_id: { type: 'string' }, state: { type: 'string' } } },
          run: { type: 'object', properties: { number: { type: 'integer' }, state: { type: 'string' } } },
          outputs: { type: 'object' },
        },
      },
    },
    303: { description: 'A browser gets its run page back; the same action serves the interface.' },
    409: { description: 'That job is not waiting for anybody: it never was a gate, or somebody already opened it.' },
    422: { description: 'A field the gate declared is missing or is not one of its options.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'workflow:approve')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    const key = String(request.get('job') ?? '').trim()

    if (!Number.isInteger(number) || number <= 0 || !key)
      return response.json({ error: 'A run number and a job are required' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const job = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'job_id', 'state', 'settings', 'name', 'kind'])
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', key)
      .executeTakeFirst()

    if (!job)
      return response.json({ error: 'No such job in this run' }, 404)

    /*
     * Answered as a conflict rather than an error, and with the state.
     *
     * Two people looking at the same run and both pressing the button is an
     * ordinary thing that happens, and the second one has not made a mistake -
     * they need to be told it is already open, not given a failure.
     */
    if (String(job.state) !== 'paused') {
      return response.json({
        job: { job_id: String(job.job_id), state: String(job.state) },
        run: { number, state: String(run.state) },
        reason: String(job.state) === 'succeeded'
          ? 'Somebody has already opened this gate.'
          : `This job is ${String(job.state)}, so there is nothing waiting for a decision.`,
      }, 409)
    }

    /*
     * An environment gate is a different thing from a `block:` gate, though
     * both are a paused job.
     *
     * A block gate is written into the workflow and opened by anybody with
     * `workflow:approve`. An environment gate is attached to the environment in
     * the repository, and it names *who* may open it - which is the whole
     * reason to have one, because a rule a workflow author can edit is a rule
     * they can remove on the afternoon they are in a hurry.
     */
    const environment = String(settingsOf(job.settings).environment ?? '')

    if (environment && String(job.kind ?? 'command') === 'command') {
      const answer = await approveEnvironment({
        repositoryId: Number(repository.id),
        runId: Number(run.id),
        job,
        environment,
        userId: Number(auth.context.user?.id ?? 0),
        handle: String(auth.context.user?.handle ?? ''),
      })

      if (!answer.ok)
        return response.json({ error: answer.error, reason: answer.reason }, answer.status)

      const state = await settleRun(Number(run.id))

      if (wantsHtml(request)) {
        const owner = String(request.get('owner') ?? '')
        return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
      }

      return response.json({
        job: { job_id: String(job.job_id), state: answer.state },
        run: { number, state },
        environment,
        reason: answer.note,
      })
    }

    const declared = fieldsOf(job.settings)
    const values: Record<string, string> = {}
    const problems: string[] = []

    for (const field of declared) {
      const supplied = request.get(String(field.key))
      const given = supplied === undefined || supplied === null ? '' : String(supplied).trim()
      const value = given || String(field.default ?? '')

      if (!value && field.required) {
        problems.push(`\`${String(field.key)}\` is required.`)
        continue
      }

      if (field.type === 'select' && value && !field.options.includes(value)) {
        // Named rather than "invalid input": the whole reason to declare
        // options is that somebody can be told which ones there are.
        problems.push(`\`${value}\` is not one of ${field.options.map((option: string) => `\`${option}\``).join(', ')}.`)
        continue
      }

      if (field.type === 'boolean' && value && !['true', 'false'].includes(value)) {
        problems.push(`\`${String(field.key)}\` is a boolean, so it is \`true\` or \`false\`.`)
        continue
      }

      if (value)
        values[String(field.key)] = value
    }

    if (problems.length > 0)
      return response.json({ error: 'This gate was not opened', problems }, 422)

    const now = new Date().toISOString()

    const result = await db
      .updateTable('workflow_jobs')
      .set({
        state: 'succeeded',
        finished_at: now,
        approved_by_id: auth.context.user?.id ?? null,
        approved_at: now,
        // The typed values, as this job's outputs: a later job reads them the
        // same way it reads any other job's.
        outputs: Object.keys(values).length > 0 ? JSON.stringify(values) : null,
        condition_reason: `Opened by ${String(auth.context.user?.handle ?? 'somebody with write access')}.`,
      } as any)
      .where('id', '=', Number(job.id))
      // Guarded on the state it was read at, so two people pressing at once
      // means one opening and one being told it is already open.
      .where('state', '=', 'paused')
      .execute()

    if (!changed(result)) {
      return response.json({
        job: { job_id: String(job.job_id), state: 'succeeded' },
        run: { number, state: String(run.state) },
        reason: 'Somebody opened this gate a moment before you did.',
      }, 409)
    }

    const state = await settleRun(Number(run.id))

    if (wantsHtml(request)) {
      const owner = String(request.get('owner') ?? '')
      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json({
      job: { job_id: String(job.job_id), state: 'succeeded' },
      run: { number, state },
      outputs: values,
    })
  },
})

/**
 * Opening the gate an environment puts in front of a deploy.
 *
 * Two checks the block gate has no equivalent of, and both are the point of an
 * environment: the approver must be one of its reviewers, and **must not be
 * whoever started the run**. A required reviewer who can approve their own
 * deploy is a rule that reads as two people and behaves as one.
 *
 * Approving does not necessarily queue the job. A wait timer that has not
 * elapsed still holds it, and saying "approved, and it will start in eleven
 * minutes" is the honest answer - claiming it is running when it is not sends
 * somebody to look for a runner that has nothing to do.
 */
interface EnvironmentApproval {
  repositoryId: number
  runId: number
  job: any
  environment: string
  userId: number
  handle: string
}

type ApprovalOutcome =
  | { ok: true, state: string, note: string }
  | { ok: false, error: string, reason?: string, status: number }

async function approveEnvironment(input: EnvironmentApproval): Promise<ApprovalOutcome> {
  const rules = await environmentRules(input.repositoryId, input.environment)

  if (!rules)
    return { ok: false, error: 'That environment does not exist here', status: 404 }

  const run = await db
    .selectFrom('workflow_runs')
    .select(['actor_id', 'event_ref'])
    .where('id', '=', input.runId)
    .executeTakeFirst()
    .catch(() => null)

  const allowed = mayApprove(rules, input.userId, run?.actor_id ? Number(run.actor_id) : null)

  if (!allowed.ok)
    return { ok: false, error: 'You may not approve this deploy', reason: allowed.reason, status: 403 }

  const now = new Date()

  await db
    .updateTable('workflow_jobs')
    .set({
      approved_by_id: input.userId || null,
      approved_at: now.toISOString(),
      condition_reason: `${rules.name} approved by ${input.handle || 'a reviewer'}.`,
    } as any)
    .where('id', '=', Number(input.job.id))
    .where('state', '=', 'paused')
    .execute()

  /*
   * Back to blocked, so the settler decides what happens next by the same code
   * that decided to hold it. Queueing it here would be a second place that
   * knows about wait timers, and the two would disagree the first time one
   * changed.
   */
  await db
    .updateTable('workflow_jobs')
    .set({ state: 'blocked' } as any)
    .where('id', '=', Number(input.job.id))
    .where('state', '=', 'paused')
    .execute()

  const held = rules.waitMinutes > 0

  return {
    ok: true,
    state: held ? 'paused' : 'queued',
    note: held
      ? `Approved. ${rules.name} holds a deploy for ${rules.waitMinutes} minutes, so it starts after that.`
      : `Approved. The deploy is queued.`,
  }
}

/** A job's settings, which are JSON in a column. */
function settingsOf(settings: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

/** The fields a gate declared, out of the settings column. */
function fieldsOf(settings: unknown): any[] {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return Array.isArray(parsed?.fields) ? parsed.fields : []
  }
  catch {
    /*
     * Unreadable settings mean a gate with no fields rather than a refusal.
     * The gate itself is the point; a field list this cannot parse should not
     * be the reason a deployment cannot be approved at all.
     */
    return []
  }
}

/** This driver answers with a plain number; see `Runner/claim.ts`. */
function changed(result: any): boolean {
  if (typeof result === 'number')
    return result > 0

  if (typeof result === 'bigint')
    return result > 0n

  const first = Array.isArray(result) ? result[0] : result
  const affected = first?.numUpdatedRows ?? first?.numAffectedRows ?? first?.rowCount

  return affected === undefined || affected === null ? false : Number(affected) > 0
}
