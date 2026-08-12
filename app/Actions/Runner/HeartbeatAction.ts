import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authenticateRunner } from './authenticate'
import { heartbeat } from './claim'

/**
 * "I am still here, and still working on this."
 *
 * The renewal that makes short leases workable. A long lease means a job held
 * by a machine that fell over is stuck for as long as the lease; a short one
 * plus this is a job that comes back within a minute of a machine going quiet.
 *
 * **A refused heartbeat is information, not an error to swallow.** It means the
 * job is no longer this runner's - the lease lapsed and somebody else took it,
 * or a person cancelled the run - and the right response on the runner's side
 * is to stop working, because anything it reports afterwards will be refused
 * anyway. So it answers 409 with the reason rather than 200 with a shrug.
 */
export default new Action({
  name: 'RunnerHeartbeat',
  description: 'Extend the lease on a job a runner holds',
  method: 'POST',

  validations: {
    job: { rule: schema.number().required() },
  },

  async handle(request: any) {
    const runner = await authenticateRunner(request)
    if (!runner)
      return response.json({ error: 'Unknown runner' }, 401)

    const jobId = Number(request.get('job'))
    if (!Number.isInteger(jobId) || jobId <= 0)
      return response.json({ error: 'A job id is required' }, 422)

    const expires = await heartbeat(runner.facts, jobId)

    if (!expires) {
      return response.json({
        error: 'This job is no longer yours',
        fix: 'Stop working on it. The lease lapsed, or the run was cancelled.',
      }, 409)
    }

    return response.json({ lease_expires_at: expires })
  },
})
