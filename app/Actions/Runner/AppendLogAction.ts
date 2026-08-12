import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authenticateJob } from './authenticate'
import { appendLog } from './logs'

/**
 * Output from a job, as it happens.
 *
 * Authenticated by the job token, which names the job - so a runner cannot
 * append to somebody else's log, and there is no job id in the request to get
 * wrong.
 *
 * **Past the ceiling this answers 200 and keeps nothing.** Refusing would make
 * a correct runner retry a chunk that will never be wanted, and a build that
 * fails because its logging was rate-limited is a worse outcome than a log that
 * says where it stopped. The response says `truncated` so a runner can stop
 * sending, rather than leaving it to guess from silence.
 */
export default new Action({
  name: 'AppendLog',
  description: 'Append output to a job this runner holds',
  method: 'POST',

  validations: {
    sequence: { rule: schema.number().required() },
    content: { rule: schema.string() },
    stream: { rule: schema.enum(['stdout', 'stderr']) },
  },

  async handle(request: any) {
    const held = await authenticateJob(request)
    if (!held)
      return response.json({ error: 'Unknown job credential' }, 401)

    const outcome = await appendLog({
      jobId: held.jobId,
      sequence: Number(request.get('sequence')),
      content: String(request.get('content') ?? ''),
      stream: request.get('stream') === 'stderr' ? 'stderr' : 'stdout',
    })

    if (!outcome.ok)
      return response.json({ error: outcome.reason }, 422)

    return response.json({
      stored: !outcome.duplicate,
      duplicate: outcome.duplicate,
      truncated: outcome.truncated,
    })
  },
})
