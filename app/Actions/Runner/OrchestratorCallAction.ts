import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { DEFAULT_BUDGETS, overWallTime, record, resolve, suspend } from '../Workflow/journal'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * What a workflow program calls when it calls `step()`.
 *
 * **The control plane never evaluates repository code.** A code-first workflow
 * is dispatched to a runner like any other untrusted work, and its `step()`
 * calls come back here as authenticated requests. That is the whole
 * architectural decision: Cloudflare can evaluate workflow code in their
 * control plane because their control plane is a Workers isolate and running
 * untrusted code is what it is for. Ours is a Bun process holding the database,
 * the session keys, and every bare repository on disk.
 *
 * ## The credential is the scoping
 *
 * A job token, and nothing else. It names one job of one run, so an
 * orchestrator can journal calls for its own run and cannot reach another's -
 * there is no run identifier in the request to get wrong, because there is no
 * run identifier in the request at all.
 *
 * ## The four kinds
 *
 * - **`step`** - real work. `dispatch` means the caller owns it.
 * - **`sleep`** - park until a time and release the runner. A workflow waiting
 *   three days for an approval must not hold a lease for three days.
 * - **`now`** and **`random`** - the injected equivalents of the two things a
 *   deterministic program may not read directly. They are journaled like
 *   everything else, so a replay sees the value it saw the first time. Without
 *   them, determinism would be a rule nobody could follow: a workflow that
 *   needs a timestamp would have no way to get one that survives a restart.
 */
export default new Action({
  name: 'OrchestratorCall',
  description: 'Journal one call of a workflow program, and say whether to do the work',
  method: 'POST',

  validations: {
    sequence: { rule: schema.number().required() },
    kind: { rule: schema.string() },
    name: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'What to do with this call.',
      schema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            description: '`dispatch` to do the work, `replay` for a recorded result, `wait` while somebody else does it, `failed` for a call that already failed, `diverged` when the program is not the one that produced this journal, `refused` when a budget is spent.',
          },
          result: { description: 'The recorded value, on a replay.' },
          entry_id: { type: 'integer', description: 'Pass this back when reporting what the call returned.' },
          reason: { type: 'string' },
          wake_at: { type: 'string' },
        },
      },
    },
    409: { description: 'The program diverged from its journal, or a budget is spent. The run is over and the reason says which.' },
    426: { description: 'This runner speaks a protocol version the server does not.' },
    401: { description: 'No job credential, or one this instance does not recognise.' },
    404: { description: 'The credential names a job whose run has gone.' },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const job: any = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select([
        'workflow_jobs.id as job_id',
        'workflow_runs.id as run_id',
        'workflow_runs.repository_id as repository_id',
        'workflow_runs.started_at as started_at',
        'workflow_runs.created_at as created_at',
      ])
      .where('workflow_jobs.id', '=', held.jobId)
      .executeTakeFirst()
      .catch(() => null)

    if (!job)
      return runnerJson({ error: 'No such job' }, 404)

    /*
     * Wall time first, before anything is written down.
     *
     * It is the one budget that is not about a call - a workflow sleeping for a
     * week makes no calls while it does it - so a run that has outlived it must
     * be stopped on the way in rather than after its next step has been
     * journaled and dispatched.
     */
    if (overWallTime(job.started_at ?? job.created_at, Date.now())) {
      return runnerJson({
        decision: 'refused',
        reason: `this run has been going for longer than its limit of ${Math.round(DEFAULT_BUDGETS.maxWallMs / 60_000)} minutes`,
      }, 409)
    }

    const sequence = Number(request.get('sequence'))

    if (!Number.isInteger(sequence) || sequence < 1)
      return runnerJson({ error: 'A call needs its position, counting from 1' }, 422)

    const kind = String(request.get('kind') ?? 'step').trim() || 'step'
    const name = String(request.get('name') ?? '').trim()
    const args = request.get('arguments') ?? {}

    const verdict = await record({
      runId: Number(job.run_id),
      repositoryId: Number(job.repository_id) || null,
      sequence,
      kind,
      name,
      args,
    })

    /*
     * A divergence and a spent budget are both the end of the run, and both
     * answer 409 - because the caller's correct response to either is to stop,
     * not to retry. A 500 would be retried by a well-behaved client forever.
     */
    if (verdict.decision === 'diverged' || verdict.decision === 'refused')
      return runnerJson({ decision: verdict.decision, reason: verdict.reason }, 409)

    if (verdict.decision === 'replay')
      return runnerJson({ decision: 'replay', result: verdict.result, entry_id: verdict.entryId })

    if (verdict.decision === 'failed')
      return runnerJson({ decision: 'failed', reason: verdict.error, entry_id: verdict.entryId })

    if (verdict.decision === 'wait')
      return runnerJson({ decision: 'wait', entry_id: verdict.entryId, wake_at: verdict.wakeAt ?? null })

    /*
     * The injected values, answered here rather than dispatched.
     *
     * `now` and `random` are the two things a deterministic program may not
     * read for itself. Resolving them immediately - and recording what they
     * were - is what makes the rule followable: the program gets a real
     * timestamp, and gets the *same* timestamp when it replays.
     */
    if (kind === 'now' || kind === 'random') {
      const value = kind === 'now' ? new Date().toISOString() : Math.random()

      await resolve(verdict.entryId, { result: value })

      return runnerJson({ decision: 'replay', result: value, entry_id: verdict.entryId })
    }

    if (kind === 'sleep') {
      const ms = Math.max(0, Number((args as any)?.ms ?? 0))
      const wakeAt = new Date(Date.now() + ms)

      await suspend(verdict.entryId, wakeAt)

      // `wait`, not `dispatch`: the caller's job now is to stop and let its
      // runner go, which is the difference between a workflow that can wait
      // three days and one that holds a machine for three days.
      return runnerJson({ decision: 'wait', entry_id: verdict.entryId, wake_at: wakeAt.toISOString() })
    }

    return runnerJson({ decision: 'dispatch', entry_id: verdict.entryId })
  },
})
