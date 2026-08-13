import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { readLog } from '../Runner/logs'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * A job's output, from wherever the reader got to.
 *
 * Behind the repository's own read permission rather than the runner's
 * credential: a log is the repository's data, and somebody who cannot see the
 * code cannot see what building it printed. That matters more here than it
 * looks - build output routinely contains paths, hostnames and the occasional
 * thing somebody echoed by mistake.
 *
 * The cursor is a chunk sequence rather than a byte offset, because a byte
 * offset into a log that is still being written means something different a
 * second later.
 */
export default new Action({
  name: 'ShowJobLog',
  description: 'Read a job\'s output from a cursor',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    job: { rule: schema.number().required() },
    after: { rule: schema.number() },
  },

  responses: {
    200: {
      description: 'The job output after the cursor, and the cursor to pass next time. Unchanged when there is nothing new, rather than an empty page that looks like the end.',
      schema: {
        type: 'object',
        properties: {
          chunks: { type: 'array', items: { type: 'object' } },
          cursor: { type: 'integer' },
          state: { type: 'string', description: 'The job\'s state, so a client following the output knows when to stop asking without a second request.' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such repository, or a job that is not this one\'s - the job id is a number anybody can increment.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const jobId = Number(request.get('job'))

    // The job has to belong to this repository. Without this check the id is a
    // number anybody can increment to read another repository's output.
    const job: any = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.id as id', 'workflow_jobs.state as state'])
      .where('workflow_jobs.id', '=', jobId)
      .where('workflow_runs.repository_id', '=', repository.id)
      .executeTakeFirst()

    if (!job)
      return response.json({ error: 'No such job' }, 404)

    const page = await readLog(jobId, Number(request.get('after') ?? 0))

    /*
     * The job's state, beside its output.
     *
     * A client following a log has to know when to stop asking, and the state
     * is the only thing that says so - a job can be quiet for a minute in the
     * middle of a step and quiet forever after it ends, and those look
     * identical from the chunks alone. Sending it here saves that client a
     * second request per poll against an endpoint that has already read the
     * row.
     */
    return response.json({ ...page, state: String(job.state) })
  },
})
