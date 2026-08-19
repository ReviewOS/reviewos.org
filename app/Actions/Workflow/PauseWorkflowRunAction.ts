import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
import { pauseRun, resumeRun } from './pause'

/**
 * Hold a run, or let it go again.
 *
 * The control between "let it finish" and "cancel it", and the one people
 * actually want: a dependency looks wrong, the fleet is on fire, somebody wants
 * to look at a workspace before the next job touches it. Cancelling to buy five
 * minutes means re-running everything that had already passed.
 *
 * **What is already on a machine keeps going.** A runner mid-build cannot be
 * politely interrupted - that is why cancellation is cooperative - and a screen
 * claiming the run has stopped while a machine is still billing for it would be
 * a lie in the expensive direction. What stops is everything that has not
 * started, because the claim only hands out work from a run that is going.
 *
 * Both directions through one action, because they are one decision with a
 * sign: two endpoints would be two places that have to agree about what a
 * paused run is.
 */
export default new Action({
  name: 'PauseWorkflowRun',
  description: 'Hold a workflow run, or let a held one go again',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    /** `pause` or `resume`. Absent means pause, which is what the button says. */
    action: { rule: schema.string(), required: false },
  },

  responses: {
    200: {
      description: 'The run as it now stands. `changed` is false when it was already in that state, which is not an error: two people pressing the same button is an ordinary afternoon.',
      schema: {
        type: 'object',
        properties: {
          workflow_run: { type: 'object', properties: { number: { type: 'integer' }, state: { type: 'string' } } },
          changed: { type: 'boolean' },
        },
      },
    },
    303: { description: 'A browser gets its run page back; the same action serves the interface.' },
    409: { description: 'A run that has finished, or one on its way out through a cancellation, cannot be held.' },
    ...REPOSITORY_ERRORS,
    422: { description: 'No run number was named.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    /*
     * The same ability as cancelling. Holding a run stops other people's work
     * from starting, which is a change to the repository's state - and anybody
     * who can see a run is not therefore somebody who may stop it.
     */
    const auth = await authorizeRepository(request, 'workflow:cancel')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const resuming = String(request.get('action') ?? 'pause') === 'resume'

    const outcome = resuming
      ? await resumeRun({ runId: Number(run.id) })
      : await pauseRun({ runId: Number(run.id), actorId: auth.context.user?.id ?? null })

    if (!outcome.ok)
      return response.json({ error: outcome.error, workflow_run: { number, state: outcome.state } }, outcome.status ?? 409)

    /*
     * Recorded, and only when something moved. Holding a run is how a
     * deployment stops without anybody cancelling it, so "who held this, and
     * when did it start again" is asked afterwards - but an audit log with a
     * line per idempotent repeat is one nobody reads.
     */
    if (outcome.changed) {
      await auditEvent(resuming ? 'workflow:run-resumed' : 'workflow:run-paused', {
        subject: { type: 'workflow_run', id: Number(run.id) },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId: Number(repository.id),
        detail: { number, state: outcome.state },
      }).catch(() => null)
    }

    if (wantsHtml(request)) {
      const owner = String(request.get('owner') ?? '')

      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json({
      workflow_run: { number, state: outcome.state },
      changed: outcome.changed,
    })
  },
})
