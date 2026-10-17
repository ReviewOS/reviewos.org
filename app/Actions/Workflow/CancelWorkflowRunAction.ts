import { Action } from '@stacksjs/actions'
import { auditFrom } from '../Git/audit'
import { schema } from '@stacksjs/validation'
import { cancelRun } from './cancel'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Stop a run.
 *
 * Cooperative first, which is why the run goes to `cancelling` rather than
 * straight to `cancelled`: the jobs are on machines this instance does not
 * control, and claiming they have stopped before they have is a screen telling
 * somebody work has ended while it is still running - and still costing them.
 *
 * **The lease is revoked here, at the moment of the request**, rather than when
 * a runner acknowledges it. That is what stops a worker which has already lost
 * its connection coming back to publish a success over a run somebody
 * cancelled, and it is the difference between a cancellation that holds and one
 * that races.
 *
 * A run that has already finished is not an error. Cancelling something that
 * ended a moment ago is an ordinary thing to do - two people looking at the
 * same screen, a click that arrived late - and answering 409 makes the client
 * handle a case where nothing is wrong. It answers with the state, and the
 * state is the truth.
 */
export default new Action({
  name: 'CancelWorkflowRun',
  description: 'Cancel a workflow run',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    reason: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'The run as it now stands. `cancelled` is false when it had already finished, which is not an error: cancelling something that ended a moment ago is an ordinary thing to do.',
      schema: {
        type: 'object',
        properties: {
          workflow_run: { type: 'object', properties: { number: { type: 'integer' }, state: { type: 'string' } } },
          cancelled: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    303: { description: 'A browser gets its run page back. The same action serves the interface, so it answers HTML callers with a redirect.' },
    409: { description: 'The run is in a state that cannot be cancelled.' },
    ...REPOSITORY_ERRORS,
    422: { description: 'No run number was named.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    // Write access, not read: stopping somebody's build is a change to the
    // repository's state, and anybody who can see a run is not therefore
    // somebody who can stop it.
    const auth = await authorizeRepository(request, 'workflow:cancel')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const result = await cancelRun({
      repositoryId: Number(repository.id), number,
      reason: String(request.get('reason') ?? ''),
      actor: { actorId: auth.context.user?.id ?? null, ...await auditFrom(request) },
    })

    if (result.status !== 200 || !('cancelled' in result.body) || !result.body.cancelled)
      return response.json(result.body, result.status)

    /*
     * A browser gets its page back; a program gets the row.
     *
     * The interface posts an ordinary form to this action rather than to a
     * route of its own - a control the screen has and the API does not is how a
     * product grows a second, undocumented way to change its own state - so
     * this has to answer both callers. Without the redirect the reader lands on
     * a page of JSON, which is a working feature that looks broken.
     */
    if (wantsHtml(request)) {
      const owner = String(request.get('owner') ?? '')
      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json(result.body, result.status)
  },
})

/** Whether this arrived from a form rather than from fetch. */
function wantsHtml(request: RequestInstance): boolean {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}
