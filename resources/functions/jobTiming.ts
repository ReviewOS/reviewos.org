/** The control plane records allocation intervals, not an inference from step count. */
export function timestamp(value: unknown): number | null {
  if (!value) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function jobTiming(row: any, now = Date.now()) {
  const queued = timestamp(row.queued_at)
  const started = timestamp(row.started_at)
  const finished = timestamp(row.finished_at)
  const terminal = ['succeeded', 'failed', 'cancelled', 'skipped'].includes(String(row.state))
  const end = finished ?? (!terminal && (started !== null || queued !== null) ? now : null)
  const control = ['block', 'await', 'barrier', 'trigger'].includes(String(row.kind))
  const orchestrator = row.orchestrator === true || row.orchestrator === 1 || row.orchestrator === '1'
  const tracked = row.execution_ms !== null && row.execution_ms !== undefined
  const intervalStart = timestamp(row.execution_started_at)
  const wall = started !== null && end !== null ? Math.max(0, end - started) : 0
  const runKnown = control || (started !== null && end !== null && (!orchestrator || tracked))
  const runMs = control ? 0 : tracked ? Math.min(wall, Number(row.execution_ms) + (intervalStart !== null && end !== null ? Math.max(0, end - intervalStart) : 0)) : runKnown ? wall : 0
  const waitKnown = !control && ((!orchestrator && queued !== null && (started ?? end) !== null) || (tracked && row.queue_ms !== null && row.queue_ms !== undefined))
  const currentQueue = row.state === 'queued' && queued !== null && end !== null ? Math.max(0, end - queued) : 0
  const waitMs = !waitKnown ? 0 : tracked ? Number(row.queue_ms ?? 0) + currentQueue : Math.max(0, (started ?? end ?? queued!) - queued!)
  // Subsequent machine queues occur inside wall time. The first queue precedes
  // it, so subtract only the queue accumulated after that first allocation.
  const initialQueue = tracked ? Number(row.first_queue_ms ?? 0) : queued !== null && started !== null && queued <= started ? started - queued : 0
  const holdKnown = control || (tracked && row.queue_ms !== null && row.queue_ms !== undefined && row.first_queue_ms !== null && row.first_queue_ms !== undefined)
  const holdMs = control ? wall : holdKnown ? Math.max(0, wall - runMs - Math.max(0, waitMs - initialQueue)) : 0
  return { queued, started, end, waitKnown, runKnown, waitMs, runMs, holdMs, holdKnown, orchestrator, control }
}
