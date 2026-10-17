import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { parsePositiveIdListInput, schema } from '@stacksjs/validation'
import { authenticateRunner } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/** A runner may retire only its own conclusively finished jobs, never unknown work. */
export default new Action({
  name: 'RetirableRunnerWorkspaces',
  description: 'Confirm which journaled workspaces belong to this runner and have finished',
  method: 'POST',
  validations: { job_ids: { rule: schema.array() } },
  async handle(request: RequestInstance) {
    const protocol = protocolOf(request)
    if (!protocol.ok) return refuseProtocol(protocol)
    const runner = await authenticateRunner(request)
    if (!runner) return runnerJson({ error: 'Unauthenticated' }, 401)
    const ids = parsePositiveIdListInput(request.get('job_ids'), 'job_ids', 0, 100)
    if (!ids.length) return runnerJson({ runner_id: runner.facts.id, retirable: [] })
    const rows = await db.selectFrom('workflow_job_claims')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_claims.workflow_job_id')
      .select(['workflow_job_claims.workflow_job_id as id']).distinct()
      .where('workflow_job_claims.runner_id', '=', runner.facts.id)
      .where('workflow_job_claims.workflow_job_id', 'in', ids)
      .where('workflow_jobs.state', 'in', ['succeeded', 'failed', 'cancelled', 'skipped'])
      .execute()
    return runnerJson({ runner_id: runner.facts.id, retirable: rows.map(row => Number(row.id)) })
  },
})
