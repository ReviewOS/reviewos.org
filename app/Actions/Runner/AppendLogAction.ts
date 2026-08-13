import { Action } from '@stacksjs/actions'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
import { schema } from '@stacksjs/validation'
import { authenticateJob } from './authenticate'
import { appendLog } from './logs'
import { parseEvents } from './logevents'

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

  responses: {
    426: {
      description: 'This runner speaks a protocol version the server does not. The body says which end is behind; every answer carries X-Runner-Protocol-Supported.',
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
  },

  responseHeaders: {
    'X-Runner-Protocol-Supported': {
      description: 'The protocol version, or range of versions, this server speaks. On every answer, so a runner about to be retired learns it from an ordinary poll rather than from the first request that fails.',
      schema: { type: 'string' },
    },
  },

  validations: {
    sequence: { rule: schema.number().required() },
    content: { rule: schema.string() },
    stream: { rule: schema.enum(['stdout', 'stderr']) },
  },

  async handle(request: any) {
    /*
     * Before anything else, including the credential.
     *
     * A runner speaking a protocol this server does not is going to
     * misread whatever it is handed, and telling it that its token is
     * fine first only delays the confusion. The refusal names which way
     * the mismatch runs, because upgrading a fleet and upgrading a
     * server are different afternoons.
     */
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    /*
     * Text or events, and text is not deprecated.
     *
     * A runner that sends what its build printed is doing the honest thing, and
     * requiring structure to say "here is a line" would be a protocol nobody
     * could write in an afternoon. Events are for the four things text cannot
     * carry - which lines were grouped, when the job printed them, which stream
     * each came from, and where colour started - and a runner that sends them
     * does not also have to send the flattened form.
     */
    const events = parseEvents(request.get('events'))

    const outcome = await appendLog({
      jobId: held.jobId,
      sequence: Number(request.get('sequence')),
      content: String(request.get('content') ?? ''),
      stream: request.get('stream') === 'stderr' ? 'stderr' : 'stdout',
      events,
    })

    if (!outcome.ok)
      return runnerJson({ error: outcome.reason }, 422)

    return runnerJson({
      stored: !outcome.duplicate,
      duplicate: outcome.duplicate,
      truncated: outcome.truncated,
      // How many of the events sent were understood. A runner ahead of this
      // server can see that some were dropped rather than assuming they landed.
      events: events.length,
    })
  },
})
