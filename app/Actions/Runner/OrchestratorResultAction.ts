import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { resolve } from '../Workflow/journal'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * What a call returned, reported by the orchestrator that owned it.
 *
 * The second half of the journal's write. `POST /runner/orchestrator` writes a
 * call down as pending *before* the work is dispatched, and this closes it. The
 * order is the point: recording afterwards would leave a window where a step
 * ran and nothing knows it did, and a kill in that window re-dispatches it - for
 * a step that cut a release, that is not a retry.
 *
 * ## The entry must belong to the caller's run
 *
 * The job token names one job of one run, and the entry id is the one thing
 * here the caller chooses. So it is checked against the run rather than trusted:
 * without that, an orchestrator could resolve another run's pending call with a
 * value of its own, and every replay of that run afterwards would read it. It is
 * the same shape as the wrong-job case the runner protocol had to be defended
 * against by hand, and it is checked in one query rather than two so there is no
 * moment where the id has been believed but not verified.
 *
 * ## Resolving twice is not an error
 *
 * An orchestrator that reported a result and died before reading the answer
 * reports it again on restart. Answering 200 to the second report is what makes
 * that safe; a 409 would send a correct client into a loop over work that is
 * already recorded.
 */
export default new Action({
  name: 'OrchestratorResult',
  description: 'Record what one journaled call returned',
  method: 'POST',

  validations: {
    entry_id: { rule: schema.number().required() },
  },

  responses: {
    200: {
      description: 'Recorded.',
      schema: { type: 'object', properties: { recorded: { type: 'boolean' } } },
    },
    401: { description: 'No job credential, or one this instance does not recognise.' },
    404: { description: 'No such call, or one belonging to another run.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const entryId = Number(request.get('entry_id'))

    if (!Number.isInteger(entryId) || entryId < 1)
      return runnerJson({ error: 'A result needs the entry it belongs to' }, 422)

    /*
     * One query, joined through the job the credential names. The entry is
     * found only if it is on the run this caller is actually orchestrating, so
     * an id belonging to somebody else's run reads as "no such call" - which is
     * what it is, from where the caller is standing.
     */
    const entry: any = await db
      .selectFrom('workflow_journal_entries')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_journal_entries.workflow_run_id')
      .innerJoin('workflow_jobs', 'workflow_jobs.workflow_run_id', '=', 'workflow_runs.id')
      .select(['workflow_journal_entries.id as id', 'workflow_journal_entries.state as state'])
      .where('workflow_journal_entries.id', '=', entryId)
      .where('workflow_jobs.id', '=', held.jobId)
      .executeTakeFirst()
      .catch(() => null)

    if (!entry)
      return runnerJson({ error: 'No such call on this run' }, 404)

    // Already closed. The report is a restart's duplicate rather than a second
    // opinion, and the recorded value is the one the run has been replaying.
    if (String(entry.state) === 'done' || String(entry.state) === 'failed')
      return runnerJson({ recorded: true, already: true })

    const failure = request.get('error')
    const durationMs = Number(request.get('duration_ms'))

    await resolve(entryId, {
      result: request.get('result') ?? null,
      error: failure === null || failure === undefined || failure === '' ? undefined : String(failure),
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      jobId: held.jobId,
    })

    return runnerJson({ recorded: true })
  },
})
