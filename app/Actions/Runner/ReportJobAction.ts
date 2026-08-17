import { Action } from '@stacksjs/actions'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
import { schema } from '@stacksjs/validation'
import { authenticateJob } from './authenticate'
import { reportJob } from './report'

/**
 * What a runner says when a job is done.
 *
 * The rules about whose word counts are in [protocol.ts](./protocol.ts): only
 * the lease holder, only before the lease lapses, and a repeat of something
 * already recorded is a duplicate rather than a conflict.
 *
 * **A duplicate answers 200.** Delivery is at-least-once, so a runner that did
 * not hear the first answer will say it again, and from its side the report did
 * land. Answering 409 to a correct runner doing the correct thing is how one
 * ends up retrying forever, and the retry loop is indistinguishable from a
 * broken runner in every log it appears in.
 *
 * A refusal, by contrast, is a real one: the lease lapsed, or the caller is not
 * the holder. Those are the cases where believing the runner would put a green
 * check on work nobody did.
 *
 * Authenticated by the job token from the claim, which names the job itself -
 * so "a credential used against the wrong job" stops being a case to defend
 * against and becomes one that cannot be expressed.
 */
/** The outputs a runner reported, as a map of strings or nothing. */
function readOutputs(value: unknown): Record<string, string> | null {
  const parsed = typeof value === 'string' ? tryParse(value) : value

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null

  const outputs: Record<string, string> = {}

  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>))
    outputs[name] = entry === null || entry === undefined ? '' : String(entry)

  return outputs
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

export default new Action({
  name: 'ReportJob',
  description: 'Record the result of a job a runner holds',
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
    state: { rule: schema.enum(['succeeded', 'failed', 'cancelled']) },
    error: { rule: schema.string() },
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

    // No second check on `state`. The `validations` block above refuses
    // anything else before this runs, with "State Must be one of: succeeded,
    // failed, cancelled" - and a hand-written copy of a rule the framework
    // already enforces is unreachable code that drifts from the real one.
    const state = String(request.get('state') ?? '')

    const outcome = await reportJob(held.runner, {
      jobId: held.jobId,
      state: state as 'succeeded' | 'failed' | 'cancelled',
      error: request.get('error') ?? null,
      // Read as a map of strings, and capped where the row is written rather
      // than trusted here: a runner is somebody else's machine.
      outputs: readOutputs(request.get('outputs')),
      /*
       * Untrusted like everything else a runner says, and only ever compared
       * against the statuses the *workflow* named - so the worst a lying
       * runner can do is ask for a retry the file already allowed.
       */
      exitStatus: Number.isInteger(Number(request.get('exit_status'))) ? Number(request.get('exit_status')) : null,
    })

    if (!outcome.ok)
      return runnerJson({ error: outcome.reason }, 409)

    return runnerJson({
      recorded: true,
      duplicate: outcome.duplicate,
      run_state: outcome.runState ?? null,
    })
  },
})
