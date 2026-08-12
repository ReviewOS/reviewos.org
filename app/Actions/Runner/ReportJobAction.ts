import { Action } from '@stacksjs/actions'
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
export default new Action({
  name: 'ReportJob',
  description: 'Record the result of a job a runner holds',
  method: 'POST',

  validations: {
    state: { rule: schema.enum(['succeeded', 'failed', 'cancelled']) },
    error: { rule: schema.string() },
  },

  async handle(request: any) {
    const held = await authenticateJob(request)
    if (!held)
      return response.json({ error: 'Unknown job credential' }, 401)

    // No second check on `state`. The `validations` block above refuses
    // anything else before this runs, with "State Must be one of: succeeded,
    // failed, cancelled" - and a hand-written copy of a rule the framework
    // already enforces is unreachable code that drifts from the real one.
    const state = String(request.get('state') ?? '')

    const outcome = await reportJob(held.runner, {
      jobId: held.jobId,
      state: state as 'succeeded' | 'failed' | 'cancelled',
      error: request.get('error') ?? null,
    })

    if (!outcome.ok)
      return response.json({ error: outcome.reason }, 409)

    return response.json({
      recorded: true,
      duplicate: outcome.duplicate,
      run_state: outcome.runState ?? null,
    })
  },
})
