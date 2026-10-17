import { db } from '@stacksjs/database'
import type { AuditPayload } from '../../Audit/events'
import { auditEvent } from '../../Audit/events'
import { rowsChanged } from '../Support/sql'
import { announceRunIfMoved } from './announce'
import { settleRun } from './settle'
import type { RunState } from './states'
import { canRunMove, isTerminalRun } from './states'

export type CancelRunResult =
  | { status: 404 | 422, body: { error: string } }
  | { status: 200 | 409, body: { workflow_run: { number: number, state: string }, cancelled: boolean, reason: string } }

/**
 * The shared operation for an authorized API caller or a trusted local operator.
 * Callers authorize access before entering here. A local operator supplies an
 * explicit externalActor such as local-ssh:root@host, never an invented user or
 * HTTP credential. Both paths revoke leases and emit the same audit event.
 */
export async function cancelRun(input: {
  repositoryId: number
  number: number
  reason: string
  actor: Pick<AuditPayload, 'actorId' | 'externalActor' | 'tokenId' | 'ip' | 'userAgent'>
}): Promise<CancelRunResult> {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.number) || input.number <= 0)
    return { status: 422, body: { error: 'A repository and run number are required' } }

  const reason = String(input.reason ?? '').slice(0, 1000) || 'Cancelled by request'
  const now = new Date().toISOString()
  const outcome = await db.transaction(async (handle) => {
    const client: any = handle
    const run = await client.selectFrom('workflow_runs').select(['id', 'state'])
      .where('repository_id', '=', input.repositoryId).where('number', '=', input.number).executeTakeFirst()
    if (!run)
      return { result: { status: 404, body: { error: 'No such workflow run' } } as CancelRunResult }

    const state = String(run.state) as RunState
    const unchanged = (current: string): CancelRunResult => ({
      status: isTerminalRun(current as RunState) ? 200 : 409,
      body: {
        workflow_run: { number: input.number, state: current }, cancelled: false,
        reason: isTerminalRun(current as RunState) ? 'This run had already finished.' : `A run that is ${current} cannot be cancelled.`,
      },
    })
    if (isTerminalRun(state) || !canRunMove(state, 'cancelling'))
      return { result: unchanged(state) }

    const changed = await client.updateTable('workflow_runs')
      .set({ state: 'cancelling', conclusion_reason: reason })
      .where('id', '=', Number(run.id)).where('state', '=', state).execute()
    // A concurrent report or cancellation won. Do not touch its jobs or emit
    // an audit record claiming this caller stopped it.
    if (!rowsChanged(changed)) {
      const current = await client.selectFrom('workflow_runs').select(['state'])
        .where('id', '=', Number(run.id)).executeTakeFirst()
      return { result: unchanged(String(current?.state ?? state)) }
    }

    await client.updateTable('workflow_jobs').set({ state: 'cancelled', finished_at: now })
      .where('workflow_run_id', '=', Number(run.id)).where('state', 'in', ['blocked', 'queued']).execute()
    await client.updateTable('workflow_jobs').set({ state: 'cancelling', lease_expires_at: now })
      .where('workflow_run_id', '=', Number(run.id)).where('state', '=', 'running').execute()

    return {
      runId: Number(run.id), from: state,
      result: {
        status: 200,
        body: { workflow_run: { number: input.number, state: 'cancelling' }, cancelled: true, reason },
      } as CancelRunResult,
    }
  })

  if (outcome.runId !== undefined) {
    await announceRunIfMoved(input.repositoryId, outcome.runId, outcome.from!, 'cancelling')
    await auditEvent('workflow:run-cancelled', {
      ...input.actor, subject: { type: 'workflow_run', id: outcome.runId }, repositoryId: input.repositoryId,
      reason, detail: { number: input.number, from: outcome.from, reason },
    })
    // Queued jobs are already terminal. No worker will report back to settle
    // their run, close an awaiting parent trigger, or release its group.
    // Running jobs still settle to cancelling until their lease is acknowledged.
    const next = await settleRun(outcome.runId)
    await announceRunIfMoved(input.repositoryId, outcome.runId, 'cancelling', next)
    if ('workflow_run' in outcome.result.body)
      outcome.result.body.workflow_run.state = next
  }
  return outcome.result
}
