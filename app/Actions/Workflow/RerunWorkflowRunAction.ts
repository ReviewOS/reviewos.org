import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import type { RerunScope } from './rerun'
import { rerunRun } from './rerun'

/**
 * Run it again.
 *
 * Three scopes, because they answer three different questions. **The whole
 * run** is "the world changed" - a dependency was fixed, a machine was
 * replaced. **The failed jobs** is the ordinary one, and it has to include the
 * jobs that were skipped *because* those failed, or the second attempt reports
 * a run still missing half its work and calls it green. **One job** is a person
 * who knows exactly which thing was flaky.
 *
 * A re-run is a new attempt of the same run rather than a new run. The commit,
 * the workflow version and the number are unchanged, and two rows would leave a
 * reader guessing which was the answer.
 *
 * **The earlier attempt stays readable.** Its logs keep their attempt number,
 * which is the whole point: somebody re-running a job is comparing it against
 * the failure, and a system that erases the failure has thrown away the reason
 * they pressed the button.
 */
export default new Action({
  name: 'RerunWorkflowRun',
  description: 'Run a finished workflow run again, as a new attempt',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    scope: { rule: schema.string(), required: false },
    job: { rule: schema.string(), required: false },
  },

  responses: {
    200: {
      description: 'The run, now on a new attempt, and how many jobs went back into the graph.',
      schema: {
        type: 'object',
        properties: {
          workflow_run: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              state: { type: 'string' },
              attempt: { type: 'integer' },
            },
          },
          jobs: { type: 'integer', description: 'How many jobs are running again, including the ones that were skipped because of them.' },
        },
      },
    },
    303: { description: 'A browser gets its run page back.' },
    409: { description: 'The run has not finished. Two attempts of one job in flight is what the lease exists to prevent.' },
    422: { description: 'Nothing matched the scope: no failures to re-run, or no job by that name.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    /*
     * The same permission as cancelling, and for the same reason: spending the
     * fleet's machines on somebody's repository is a change to that
     * repository's state, and anybody who can *see* a run is not therefore
     * somebody who may start it again.
     */
    const auth = await authorizeRepository(request, 'workflow:cancel')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    const asked = String(request.get('scope') ?? 'failed')
    const scope: RerunScope = asked === 'all' || asked === 'job' ? asked : 'failed'

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    const outcome = await rerunRun({
      runId: Number(run.id),
      scope,
      jobKey: request.get('job') ? String(request.get('job')) : null,
    })

    if (!outcome.ok)
      return response.json({ error: outcome.error }, outcome.status ?? 422)

    /*
     * A browser gets its page back; a program gets the row. The interface posts
     * an ordinary form to this action rather than to a route of its own - a
     * control the screen has and the API does not is how a product grows a
     * second, undocumented way to change its own state.
     */
    if (String(request?.headers?.get?.('accept') ?? '').includes('text/html')) {
      const owner = String(request.get('owner') ?? '')

      return response.redirect(`/${owner}/${String(repository.name)}/run/${number}`)
    }

    return response.json({
      workflow_run: { number, state: 'queued', attempt: outcome.attempt },
      jobs: outcome.jobs,
    })
  },
})
