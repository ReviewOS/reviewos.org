import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { readLog } from '../Runner/logs'
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
      .select(['workflow_jobs.id as id'])
      .where('workflow_jobs.id', '=', jobId)
      .where('workflow_runs.repository_id', '=', repository.id)
      .executeTakeFirst()

    if (!job)
      return response.json({ error: 'No such job' }, 404)

    const page = await readLog(jobId, Number(request.get('after') ?? 0))

    return response.json(page)
  },
})
