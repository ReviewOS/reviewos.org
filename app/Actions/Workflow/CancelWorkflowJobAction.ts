import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { settleRun } from './settle'

/**
 * Stop one job, leaving the rest of the run alone.
 *
 * The case cancelling a whole run cannot serve: one job is stuck on a machine
 * that has gone quiet, or is running something somebody has already fixed, and
 * the other nine are work nobody wants to throw away. Without this the choice
 * is to lose all of it or wait for the one.
 *
 * **Cooperative first**, the same shape as cancelling a run: a job on a machine
 * goes to `cancelling` and has its lease revoked in the same write, so whatever
 * holds it can no longer report a result over a decision that has been made.
 * One that never started is `cancelled` outright - there is nobody to tell.
 *
 * The run is settled afterwards, which is what makes the rest of the graph
 * honest: the jobs that needed this one can never run now, and a run left with
 * them `blocked` is a pull request whose checks stay pending forever.
 */
export default new Action({
  name: 'CancelWorkflowJob',
  description: 'Cancel one job of a workflow run',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    job: { rule: schema.string() },
    reason: { rule: schema.string(), required: false },
  },

  responses: {
    200: {
      description: 'The job as it now stands, and what the run became.',
      schema: {
        type: 'object',
        properties: {
          job: { type: 'object', properties: { job_id: { type: 'string' }, state: { type: 'string' } } },
          run_state: { type: 'string' },
          cancelled: { type: 'boolean', description: 'False when the job had already finished, which is not an error.' },
        },
      },
    },
    303: { description: 'A browser gets its run page back.' },
    ...REPOSITORY_ERRORS,
    422: { description: 'No run number, or no job name.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    // The same ability cancelling a run asks for: stopping somebody's build is
    // a change to the repository's state, and seeing a run is not the same as
    // being allowed to stop one.
    const auth = await authorizeRepository(request, 'workflow:cancel')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))
    const key = String(request.get('job') ?? '').trim()

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    if (!key)
      return response.json({ error: 'A job name is required' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'job_id', 'state'])
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', key)
      .execute()

    if (jobs.length === 0)
      return response.json({ error: 'No such job in this run' }, 404)

    const now = new Date().toISOString()
    const reason = String(request.get('reason') ?? '').slice(0, 1000) || 'Cancelled by request'
    let cancelled = 0

    /*
     * Every row under this name, because a matrix is several rows under one -
     * cancelling `test` on a matrix of four and stopping one of them would be a
     * button that does a quarter of what it says.
     */
    for (const job of jobs) {
      const state = String(job.state)

      if (['blocked', 'queued'].includes(state)) {
        await db
          .updateTable('workflow_jobs')
          .set({ state: 'cancelled', finished_at: now, condition_reason: reason })
          .where('id', '=', Number(job.id))
          .where('state', '=', state)
          .execute()

        cancelled += 1
        continue
      }

      if (state === 'running') {
        await db
          .updateTable('workflow_jobs')
          .set({ state: 'cancelling', lease_expires_at: now, condition_reason: reason })
          .where('id', '=', Number(job.id))
          .where('state', '=', 'running')
          .execute()

        cancelled += 1
      }
    }

    /*
     * Settled afterwards, which is the half that keeps the run honest: whatever
     * needed this job can never run now, and a run left holding those blocked
     * is a pull request whose checks stay pending on work that has ended.
     */
    const runState = await settleRun(Number(run.id))

    if (String(request?.headers?.get?.('accept') ?? '').includes('text/html')) {
      const owner = String(request.get('owner') ?? '')

      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json({
      /*
       * `jobs[0]` exists - the guard above returned when the list was empty -
       * but the compiler cannot see that through the index, and `noUnchecked
       * IndexedAccess` is right to ask.
       */
      job: { job_id: key, state: cancelled > 0 ? 'cancelling' : String(jobs[0]?.state ?? '') },
      run_state: runState,
      // False rather than an error: cancelling something that finished a moment
      // ago is an ordinary thing to do, and 409 would make a client handle a
      // case where nothing is wrong.
      cancelled: cancelled > 0,
    })
  },
})
