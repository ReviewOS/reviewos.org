import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
import { listMetadata, readMetadata, writeMetadata } from './metadata'

/**
 * Values the jobs of one run pass to each other.
 *
 * A job computes a version number, a preview URL or a decision, and a job that
 * runs later needs it. An artifact is a file for a string; an output only
 * reaches jobs that declared `needs:` on the producer, so it cannot travel
 * sideways or reach a job that was generated after the fact.
 *
 * Authenticated with the **job token**, like everything else a runner says, and
 * scoped to that job's run by the token rather than by anything in the request:
 * a runner that could name the run would be able to read another run's values,
 * and those belong to a different commit.
 *
 * **`if_version` is the reason this is not a hash table.** Two parallel jobs
 * each read a list, each append, each write it back - and the second write
 * lands on top of the first with nothing anywhere saying so. A refused write is
 * a job that can merge and retry; a lost write is a build quietly missing
 * something.
 */
export default new Action({
  name: 'RunMetadata',
  description: 'Read and write the metadata shared by one run\'s jobs',
  method: 'POST',

  validations: {
    action: { rule: schema.string(), required: false },
    key: { rule: schema.string(), required: false },
    value: { rule: schema.string(), required: false },
    if_version: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The value, or everything this run has been told.',
      schema: {
        type: 'object',
        properties: {
          entry: {
            type: 'object',
            nullable: true,
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              version: { type: 'integer', description: 'How many times this key has been written. Pass it back as `if_version` to write against what you read.' },
            },
          },
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    409: { description: 'Somebody else wrote this key first. The value that is actually there comes back with the refusal, so a job can merge and try again.' },
    413: { description: 'The value is larger than a value should be. That is a file, and a file is an artifact.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)

    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)

    if (!held)
      return runnerJson({ error: 'Unknown or expired job token' }, 401)

    /*
     * The run comes from the token's job, never from the request. A runner that
     * could name the run could read and write another run's values - and those
     * belong to a different commit, which is how a deploy ships the wrong
     * build.
     */
    const job = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id'])
      .where('id', '=', held.jobId)
      .executeTakeFirst()

    if (!job)
      return runnerJson({ error: 'The credential names a job that has gone' }, 404)

    const runId = Number(job.workflow_run_id)
    const action = String(request.get('action') ?? 'get')
    const key = String(request.get('key') ?? '').trim()

    if (action === 'list')
      return runnerJson({ entries: await listMetadata(runId) })

    if (!key)
      return runnerJson({ error: 'A key is required' }, 422)

    if (action === 'get') {
      // Null rather than 404: "nobody has set this yet" is an ordinary answer a
      // script branches on, not an error it has to catch.
      return runnerJson({ entry: await readMetadata(runId, key) })
    }

    if (action !== 'set')
      return runnerJson({ error: '`action` is `get`, `set` or `list`' }, 422)

    const asked = request.get('if_version')
    const outcome = await writeMetadata({
      runId,
      key,
      value: String(request.get('value') ?? ''),
      jobId: Number(job.id),
      expectedVersion: asked === undefined || asked === null || asked === '' ? null : Number(asked),
    })

    if (!outcome.ok)
      return runnerJson({ error: outcome.error, entry: outcome.current ?? null }, outcome.status ?? 409)

    return runnerJson({ entry: outcome.entry })
  },
})
