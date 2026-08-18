import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { itemsFrom, splitForRepository } from '../Tests/history'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * The same split, for a job running here.
 *
 * A job on this instance's own runner already holds a credential that names it,
 * so asking it to also carry a repository token - stored as a secret, rotated
 * by somebody, and far broader than "read the timings for this suite" - would
 * be worse security for less convenience. The **job token** names the job,
 * which names the run, which names the repository: there is no repository in
 * the request to get wrong, and no way to ask about somebody else's.
 *
 * The answer comes from the same code as the repository-credential endpoint,
 * deliberately. Two implementations that drift is how one node computes a
 * different partition from another, and the whole scheme depends on every node
 * computing the same one.
 */
export default new Action({
  name: 'SplitTestsForJob',
  description: 'Which of these tests this node should run, for a job on this instance',
  method: 'POST',

  validations: {
    suite: { rule: schema.string() },
    nodes: { rule: schema.number() },
    index: { rule: schema.number() },
  },

  responses: {
    200: {
      description: 'The items this node should run.',
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' } },
          estimated_ms: { type: 'integer' },
          unknown: { type: 'integer' },
          note: { type: 'string', nullable: true },
        },
      },
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
    409: { description: 'Nothing to split.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
  },

  responseHeaders: {
    'X-Runner-Protocol-Supported': {
      description: 'The protocol version, or range of versions, this server speaks.',
      schema: { type: 'string' },
    },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const names = itemsFrom(request.get('items'))

    if (!names.length)
      return runnerJson({ error: 'Nothing to split', reason: 'send the files this node found, one per line or as a JSON array' }, 409)

    const repositoryId = await repositoryOf(held.jobId)

    if (!repositoryId)
      return runnerJson({ error: 'This job is not attached to a repository' }, 409)

    const nodes = Math.max(1, Math.min(500, Number(request.get('nodes')) || 1))
    const index = Math.max(0, Math.min(nodes - 1, Number(request.get('index')) || 0))

    const outcome = await splitForRepository({
      repositoryId,
      suite: String(request.get('suite') ?? 'default').trim() || 'default',
      items: names,
      nodes,
      index,
    })

    return runnerJson({
      items: outcome.items,
      estimated_ms: outcome.estimatedMs,
      unknown: outcome.unknown,
      note: outcome.note,
    })
  },
})

/** The repository this job's run belongs to. The job token names it, not the request. */
async function repositoryOf(jobId: number): Promise<number | null> {
  const row = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_runs.repository_id as repository_id'])
    .where('workflow_jobs.id', '=', jobId)
    .executeTakeFirst()
    .catch(() => null)

  return row?.repository_id ? Number(row.repository_id) : null
}
