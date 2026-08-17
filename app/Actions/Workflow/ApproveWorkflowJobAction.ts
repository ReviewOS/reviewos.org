import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
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

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'job_id', 'state', 'settings', 'name'])
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

    const result: any = await db
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
