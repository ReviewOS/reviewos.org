import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
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
    attempt: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The job output after the cursor, and the cursor to pass next time. Unchanged when there is nothing new, rather than an empty page that looks like the end: stop on `complete`, never on an empty page.',
      schema: {
        type: 'object',
        properties: {
          chunks: { type: 'array', items: { type: 'object' } },
          cursor: { type: 'integer' },
          state: { type: 'string', description: 'The job\'s state, read after this page was taken, so a terminal state cannot describe a moment before the chunks below it.' },
          complete: { type: 'boolean', description: 'The job has finished and this page was empty, so there is nothing more after the cursor. The flag to stop on; a terminal `state` on its own is not, because a job finishes with its last chunks still arriving.' },
          attempt: { type: 'integer', description: 'Which attempt this page is from. The current one unless `attempt` asked for another.' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such repository, or a job that is not this one\'s - the job id is a number anybody can increment.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:logs')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const jobId = Number(request.get('job'))

    // The job has to belong to this repository. Without this check the id is a
    // number anybody can increment to read another repository's output.
    const job = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.id as id', 'workflow_jobs.state as state', 'workflow_jobs.attempt as attempt'])
      .where('workflow_jobs.id', '=', jobId)
      .where('workflow_runs.repository_id', '=', repository.id)
      .executeTakeFirst()

    if (!job)
      return response.json({ error: 'No such job' }, 404)

    /*
     * An earlier attempt's output, when a reader asks for one.
     *
     * The reason a re-run keeps its predecessor's logs is so somebody can read
     * them, and until this parameter existed nothing could: the endpoint always
     * answered with the newest attempt. It is also what makes a kept step
     * result explicable - a step skipped on attempt three points at the
     * attempt whose log shows it doing the work.
     */
    const asked = Number(request.get('attempt') ?? 0)
    const attempt = Number.isInteger(asked) && asked > 0 ? asked : undefined

    const page = await readLog(jobId, Number(request.get('after') ?? 0), 200, attempt)

    /*
     * The job's state, read *after* the page and not before it.
     *
     * A client following a log has to know when to stop asking, and the state
     * is the only thing that says so - a job can be quiet for a minute in the
     * middle of a step and quiet forever after it ends, and those look
     * identical from the chunks alone.
     *
     * The order is the whole point. The row above was read to answer "is this
     * job in this repository", which is a question whose answer does not
     * change; reusing its `state` for this meant reporting a state observed
     * *before* the page was taken. A job that finished in between therefore
     * came back terminal beside a page that did not yet have its last chunks,
     * and a client that stops on a terminal state stopped one poll early -
     * losing exactly the lines a failure is read from. Read afterwards, a
     * terminal state is one that was already terminal when the page was
     * taken.
     */
    const current = await db
      .selectFrom('workflow_jobs')
      .select(['state'])
      .where('id', '=', jobId)
      .executeTakeFirst()

    const state = String(current?.state ?? job.state)

    const answer = response.json({
      ...page,
      state,
      attempt: attempt ?? Number((job as any).attempt ?? 1),
      /*
       * The one flag a follower can stop on without having to reason about any
       * of the above: the job has finished *and* this page was empty, so there
       * is nothing after the cursor and nothing more coming. `state` alone has
       * never been safe to stop on, because a job reaches its terminal state
       * with its last chunks still arriving.
       */
      complete: ['succeeded', 'failed', 'cancelled', 'skipped'].includes(state) && page.chunks.length === 0,
    })
    answer.headers.set('Cache-Control', 'private, no-store')
    return answer
  },
})
