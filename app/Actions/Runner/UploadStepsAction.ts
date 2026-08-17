import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { uploadSteps } from '../Workflow/upload'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * Steps a job generated, added to the run it is part of.
 *
 * Authenticated by the **job token**, which names the job - so a runner cannot
 * add work to somebody else's run, and there is no run id in the request to get
 * wrong. That is the same property the log and report endpoints have, and it is
 * what makes the trust rules enforceable: the uploaded document never gets to
 * say which run it belongs to.
 *
 * The rules themselves are in [`Workflow/upload.ts`](../Workflow/upload.ts),
 * next to the graph they change rather than here at the edge - this endpoint is
 * the credential and the wire format, and nothing else.
 *
 * **The answer is deliberately detailed on refusal.** A job generating steps is
 * a program, and a program that gets "400" back cannot do anything with it; the
 * parse errors come back in full so the *log* says which line of generated YAML
 * was wrong, which is the only place anybody will look.
 */
export default new Action({
  name: 'UploadSteps',
  description: 'Add generated jobs to the run this runner is working on',
  method: 'POST',

  validations: {
    steps: { rule: schema.string().required() },
  },

  responses: {
    200: {
      description: 'The jobs that were added.',
      schema: {
        type: 'object',
        properties: {
          added: { type: 'array', items: { type: 'integer' } },
          reason: { type: 'string' },
        },
      },
    },
    409: {
      description: 'Refused: the run is finished, the budget is spent, or the document is not valid. `problems` lists what was wrong.',
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
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

    const source = String(request.get('steps') ?? '')

    /*
     * A ceiling on the document itself, before it is parsed.
     *
     * The budget below bounds how many *jobs* a run can grow; this bounds how
     * much text one request can make the parser look at, which is a different
     * denial of service and one the parser cannot defend against on its own.
     */
    if (source.length > 200_000)
      return runnerJson({ error: 'That upload is too large', reason: 'a single upload is limited to 200KB of YAML' }, 409)

    const outcome = await uploadSteps(held.jobId, source)

    if (!outcome.ok)
      return runnerJson({ error: outcome.reason, problems: outcome.problems ?? [] }, 409)

    return runnerJson({ added: outcome.added, reason: outcome.reason })
  },
})
