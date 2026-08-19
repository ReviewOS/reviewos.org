import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
import { sendRunEvent } from './awaits'

/**
 * Tell a run something happened.
 *
 * The other half of `await:`. A run can hold still until the world tells it
 * otherwise - a deployment that finished elsewhere, an approval collected in
 * another system, a soak somebody decided to end early - and this is the
 * telling. Typed, because a run waiting for `deploy-finished` should not be
 * woken by `deploy-started`, and matched exactly for the same reason.
 *
 * **Idempotent on a key the sender chooses.** A sender that does not hear the
 * answer sends again, which is what every webhook in the world does; without a
 * key those are two events, and a run waiting for `deploy-finished` twice in a
 * loop would be let through twice on one deployment. The repeat is told it was
 * already recorded, which is the answer it would have had.
 *
 * **Recorded even when nothing is waiting**, which is the case people report as
 * a dropped message and almost never is. An event that arrives a second before
 * its job becomes eligible has nowhere to land, and the wait would sit until
 * its timeout on a message that did arrive. The row survives, and the wait
 * reads it when it starts.
 *
 * The payload becomes the waiting job's outputs, so a later job reads it as
 * `needs.approval.outputs.version` - the same way it reads any other job's.
 */
export default new Action({
  name: 'SendRunEvent',
  description: 'Send a typed event to a workflow run that is waiting for one',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    event: { rule: schema.string() },
    payload: { rule: schema.string(), required: false },
    key: { rule: schema.string(), required: false },
  },

  responses: {
    200: {
      description: 'The event as recorded, and how many waiting jobs it ended. A repeat of a key already seen answers the same way rather than delivering twice.',
      schema: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          duplicate: { type: 'boolean', description: 'This key had already been recorded, so nothing was delivered a second time.' },
          delivered: { type: 'integer', description: 'How many waiting jobs this event ended. Zero is a recorded event nothing was waiting for, which a later wait will find.' },
        },
      },
    },
    303: { description: 'A browser gets its run page back; the same action serves the interface.' },
    422: { description: 'No event name, or a payload that is not an object.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    /*
     * `workflow:approve`, not `workflow:cancel`.
     *
     * An event ends a wait, and a wait is what a deployment holds behind. This
     * is the same power as opening a gate wearing different clothes, so it
     * answers to the same ability - folding it in with cancelling would mean
     * anybody who can stop a build can also ship one.
     */
    const auth = await authorizeRepository(request, 'workflow:approve')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))
    const name = String(request.get('event') ?? '').trim()

    if (!Number.isInteger(number) || number <= 0 || !name)
      return response.json({ error: 'A run number and an event are required' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const payload = readPayload(request.get('payload'))

    if (payload === undefined)
      return response.json({ error: 'A payload is an object of values, or nothing at all.' }, 422)

    const outcome = await sendRunEvent({
      runId: Number(run.id),
      repositoryId: Number(repository.id),
      name,
      payload,
      key: request.get('key') ? String(request.get('key')) : null,
      actorId: auth.context.user?.id ?? null,
      source: wantsHtml(request) ? 'interface' : 'api',
    })

    if (!outcome.ok)
      return response.json({ error: outcome.error }, outcome.status ?? 422)

    /*
     * Recorded, because ending a wait is how a held deployment proceeds - and
     * "who or what let this through" is the question asked afterwards.
     *
     * Only for a delivery that happened. A duplicate is the sender being
     * careful, and an audit log with one entry per retry is one nobody reads.
     */
    if (!outcome.duplicate) {
      await auditEvent('workflow:run-event', {
        subject: { type: 'workflow_run', id: Number(run.id) },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId: Number(repository.id),
        detail: { number, event: name, delivered: outcome.delivered },
      }).catch(() => null)
    }

    if (wantsHtml(request)) {
      const owner = String(request.get('owner') ?? '')

      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json({
      event: name,
      duplicate: outcome.duplicate,
      delivered: outcome.delivered,
    })
  },
})

/**
 * The payload a sender supplied: an object, nothing, or a refusal.
 *
 * `undefined` back means "this is not a payload", which is different from "no
 * payload" - a caller that sent a string where an object belongs has made a
 * mistake, and quietly storing nothing would hand the waiting job empty outputs
 * and no way to find out why.
 */
function readPayload(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null || value === undefined || value === '')
    return null

  const parsed = typeof value === 'string' ? tryParse(value) : value

  if (parsed === undefined)
    return undefined

  if (parsed === null)
    return null

  return typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
