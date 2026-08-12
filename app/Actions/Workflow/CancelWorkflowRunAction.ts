import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import type { RunState } from './states'
import { canRunMove, isTerminalRun } from './states'
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

  async handle(request: any) {
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

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const state = String(run.state) as RunState

    if (isTerminalRun(state)) {
      return response.json({
        workflow_run: { number, state },
        cancelled: false,
        reason: 'This run had already finished.',
      })
    }

    if (!canRunMove(state, 'cancelling')) {
      return response.json({
        workflow_run: { number, state },
        cancelled: false,
        reason: `A run that is ${state} cannot be cancelled.`,
      }, 409)
    }

    const now = new Date().toISOString()
    const reason = String(request.get('reason') ?? '').slice(0, 1000) || 'Cancelled by request'

    await db
      .updateTable('workflow_runs')
      .set({ state: 'cancelling', conclusion_reason: reason })
      .where('id', '=', Number(run.id))
      // Guarded on the state we read. Two cancellations arriving together, or
      // a run that finished between the read and the write, must not have this
      // one overwrite what happened.
      .where('state', '=', state)
      .execute()

    /*
     * The jobs, in two groups and for two reasons.
     *
     * One that never started is `cancelled` outright - there is nothing to ask
     * to stop. One that is running goes to `cancelling` and has its lease
     * revoked, so whatever holds it can no longer report anything, whether or
     * not it is still listening.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now })
      .where('workflow_run_id', '=', Number(run.id))
      .where('state', 'in', ['blocked', 'queued'])
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling', lease_expires_at: now })
      .where('workflow_run_id', '=', Number(run.id))
      .where('state', '=', 'running')
      .execute()

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

    return response.json({
      workflow_run: { number, state: 'cancelling' },
      cancelled: true,
      reason,
    })
  },
})

/** Whether this arrived from a form rather than from fetch. */
function wantsHtml(request: any): boolean {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}
