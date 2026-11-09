import { db } from '@stacksjs/database'
import { millisFor } from '../lib/runStatus'
import { buildRunChart } from './runChart'

/** Use the runner's explicit failure first. A log excerpt is context, never a guessed cause. */
export function failureSummaries(jobs: readonly any[], steps: readonly any[], logs: readonly any[] = []) {
  return jobs.filter(job => job.state === 'failed').map((job) => {
    const step = steps.find(one => Number(one.workflow_job_id) === Number(job.id) && one.state === 'failed')
    const text = logs.filter(one => Number(one.workflow_job_id) === Number(job.id) && Number(one.attempt ?? 1) === Number(job.attempt ?? 1)).map(one => String(one.content ?? '')).join('')
    const lines = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').split('\n')
    const at = lines.findIndex(line => /\b(error|failed|panic|exception|fatal)\b/i.test(line))
    const excerpt = text ? lines.slice(Math.max(0, at < 0 ? lines.length - 5 : at - 2), at < 0 ? lines.length : at + 4).join('\n').slice(0, 2400) : ''
    return {
      id: Number(job.id), name: String(job.name || job.job_id),
      step: step ? String(step.name || `Step ${Number(step.position) + 1}`) : '',
      exit: step?.exit_code === null || step?.exit_code === undefined ? null : Number(step.exit_code),
      error: String(step?.error || job.error || 'No failure message was reported.'),
      excerpt, anchor: step ? `step-${Number(step.id)}` : `job-${Number(job.id)}`,
    }
  })
}

function stableMatrix(value: unknown): string {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object') return ''
    return JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))))
  }
  catch { return String(value ?? '') }
}

export function compareRunJobs(current: readonly any[], baseline: readonly any[], currentChart = buildRunChart(current), baselineChart = buildRunChart(baseline)) {
  const key = (row: any) => `${row.comparison_key || row.job_id}:${stableMatrix(row.matrix_values)}`
  const previous = new Map(baseline.map(row => [key(row), row]))
  const oldTiming = new Map(baselineChart.nodes.map(node => [Number(node.id), node]))
  const currentTiming = new Map(currentChart.nodes.map(node => [Number(node.id), node]))
  const delta = (now: number, before: number) => {
    const ms = now - before
    return Math.abs(ms) < 1000 ? 'About the same' : `${millisFor(Math.abs(ms))} ${ms > 0 ? 'slower' : 'faster'}`
  }
  const changes = current.map((row) => {
    const old = previous.get(key(row))
    if (old) previous.delete(key(row))
    const timing = currentTiming.get(Number(row.id))!
    const before = old ? oldTiming.get(Number(old.id)) : undefined
    const complete = ['failed', 'succeeded', 'cancelled', 'skipped'].includes(String(row.state))
    const runKnown = Boolean(complete && before?.runKnown && timing.runKnown)
    const queueKnown = Boolean(before?.waitKnown && timing.waitKnown)
    return {
      id: Number(row.id), name: String(row.name || row.job_id), state: String(row.state),
      status: !old ? (row.state === 'failed' ? 'New job, failed' : 'New job') : row.state === 'failed' ? 'Now failing' : !complete ? 'In progress' : 'Existing job',
      execution: runKnown ? delta(timing.runMs, before!.runMs) : old ? 'Not available' : 'New job',
      queue: queueKnown ? delta(timing.waitMs, before!.waitMs) : 'Not available',
      regression: row.state === 'failed' || Boolean(runKnown && timing.runMs - before!.runMs >= 1000) || Boolean(queueKnown && timing.waitMs - before!.waitMs >= 1000),
      runDelta: runKnown ? timing.runMs - before!.runMs : null,
      queueDelta: queueKnown ? timing.waitMs - before!.waitMs : null,
    }
  })
  for (const old of previous.values()) changes.push({ id: 0, name: String(old.name || old.job_id), state: '', status: 'Absent from this run', execution: 'Not available', queue: 'Not available', regression: false, runDelta: null, queueDelta: null })
  return changes.sort((a, b) => Number(b.regression) - Number(a.regression) || (b.runDelta ?? 0) - (a.runDelta ?? 0))
}

/** Same repository, workflow and exact ref. Never compare an unrelated branch or workflow. */
export async function previousSuccessfulRun(run: any, jobs: readonly any[], chart = buildRunChart(jobs)) {
  if (!run) return null
  const version = await db.selectFrom('workflow_versions').select(['workflow_id']).where('id', '=', Number(run.workflow_version_id)).executeTakeFirst()
  if (!version) return null
  let query = db.selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .select(['workflow_runs.id as id', 'workflow_runs.number as number', 'workflow_runs.started_at as started_at', 'workflow_runs.finished_at as finished_at'])
    .where('workflow_runs.repository_id', '=', Number(run.repository_id))
    .where('workflow_versions.workflow_id', '=', Number(version.workflow_id))
    .where('workflow_runs.number', '<', Number(run.number))
    .where('workflow_runs.state', '=', 'succeeded')
  query = run.event_ref === null ? query.whereNull('workflow_runs.event_ref') : query.where('workflow_runs.event_ref', '=', String(run.event_ref))
  const baseline = await query.orderBy('workflow_runs.number', 'desc').executeTakeFirst()
  if (!baseline) return null
  const previous = await db.selectFrom('workflow_jobs').selectAll().where('workflow_run_id', '=', Number(baseline.id)).execute()
  // Durable jobs have per-run database ids in job_id (call-123). Their
  // journal position and name, not that storage id, identify the same call.
  const calls = await db.selectFrom('workflow_journal_entries').select(['workflow_job_id', 'sequence', 'name', 'kind']).where('workflow_run_id', 'in', [Number(run.id), Number(baseline.id)]).execute()
  const callKeys = new Map(calls.filter(call => call.workflow_job_id).map(call => [Number(call.workflow_job_id), `journal:${call.kind}:${call.sequence}:${call.name}`]))
  const identify = (rows: readonly any[]) => rows.map(row => ({ ...row, comparison_key: callKeys.get(Number(row.id)) }))
  return { number: Number(baseline.number), jobs: compareRunJobs(identify(jobs), identify(previous), chart), ref: String(run.event_ref ?? '') }
}
