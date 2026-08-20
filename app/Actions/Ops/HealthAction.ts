import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { checkHealth } from '../../Ops/health'

/**
 * Whether this instance is actually working.
 *
 * It used to answer `{ ok: true }` unconditionally, which is the failure the
 * roadmap names: a health check that returns 200 because the process is running
 * tells a load balancer to keep sending traffic to an instance whose database is
 * gone. The process being up is the one thing that was never in doubt - it is
 * the thing answering.
 *
 * So it checks the three things that can be broken while the process is fine:
 * the database, the queue, and the disk the repositories live on. Each is
 * reported separately, because "unhealthy" sends somebody to read logs and
 * "repository storage is not writable" sends them to the volume.
 *
 * **503 when something is wrong**, so a load balancer and an orchestrator both
 * act on it without being taught anything. A body nobody parses attached to a
 * 200 is a health check that only helps the person already reading it.
 *
 * Unauthenticated on purpose. A prober is not signed in, and the body says
 * nothing an attacker gains from: which subsystem is down, not where it lives or
 * why.
 */
export default new Action({
  name: 'Health',
  description: 'Whether the database, the queue and repository storage are working',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    quick: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    /*
     * `?quick=1` skips the disk write.
     *
     * A liveness probe runs every few seconds and only needs to know the
     * process can answer; a readiness probe runs less often and wants the
     * truth. One endpoint serving both beats two that drift, and the expensive
     * check is the one a liveness probe should not be doing hundreds of times a
     * minute.
     */
    const quick = String(request.get('quick') ?? '') === '1'

    const report = await checkHealth({ writeProbe: !quick })

    return response.json(report, { status: report.ok ? 200 : 503 })
  },
})
