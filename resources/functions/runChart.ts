import { scaleLinear } from '@ts-charts/scale'
import { linkHorizontal } from '@ts-charts/shape'
import { isTerminalJob, type JobState } from '../../app/Actions/Workflow/states'
import { criticalPath, layersOf } from '../../app/Actions/Workflow/graph'
import { millisFor, runLabel, runTone } from './runs'

export interface RunChartJob {
  id: number
  job_id: string
  name?: string | null
  state: JobState
  needs?: string | null
  queued_at?: unknown
  started_at?: unknown
  finished_at?: unknown
}

function timestamp(value: unknown): number | null {
  if (!value)
    return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/** One snapshot for both charts. Missing timestamps stay unknown rather than becoming zero-duration jobs. */
export function buildRunChart(rows: readonly RunChartJob[], now = Date.now()) {
  const timed = rows.map((row) => {
    const queued = timestamp(row.queued_at)
    const started = timestamp(row.started_at)
    const finished = timestamp(row.finished_at)
    const live = !isTerminalJob(row.state)
    const end = finished ?? (live && (started !== null || queued !== null) ? now : null)
    const waitEnd = started ?? end
    const waitKnown = queued !== null && waitEnd !== null
    const runKnown = started !== null && end !== null
    return {
      id: Number(row.id),
      jobKey: String(row.job_id),
      name: String(row.name || row.job_id),
      state: String(row.state),
      needs: String(row.needs ?? '').split('\n').map(one => one.trim()).filter(Boolean),
      queued,
      started,
      end,
      waitMs: waitKnown ? Math.max(0, waitEnd - queued) : 0,
      runMs: runKnown ? Math.max(0, end - started) : 0,
      waitKnown,
      runKnown,
      hasTiming: waitKnown || runKnown,
    }
  })
  const layers = layersOf(timed)
  const path = criticalPath(timed)
  // A zero-cost path is arbitrary when no runner has reported timings yet.
  const criticalIds = new Set(path.totalMs > 0 ? path.nodes.map(node => node.id) : [])
  const width = Math.max(760, layers.length * 280 + 48)
  const height = Math.max(190, Math.max(0, ...layers.map(layer => layer.nodes.length)) * 94 + 76)
  const timedById = new Map(timed.map(node => [node.id, node]))
  const nodes = layers.flatMap((layer, depth) => layer.nodes.map((graphNode, index) => {
    const node = timedById.get(graphNode.id)!
    return {
      ...node,
      x: 24 + depth * 280,
      y: 54 + index * 94,
      tone: runTone(node.state),
      label: runLabel(node.state),
      critical: criticalIds.has(node.id),
      shortName: node.name.length > 27 ? `${node.name.slice(0, 26)}…` : node.name,
      timing: [node.waitKnown ? `${millisFor(node.waitMs)} queued` : '', node.runKnown ? `${millisFor(node.runMs)} execution` : ''].filter(Boolean).join(' · ') || 'Timing not reported',
      durationLabel: node.runKnown ? `${millisFor(node.runMs)} execution` : node.waitKnown ? `${millisFor(node.waitMs)} queued` : '',
    }
  }))
  const byKey = new Map<string, typeof nodes>()
  for (const node of nodes)
    byKey.set(node.jobKey, [...(byKey.get(node.jobKey) ?? []), node])
  const connector = linkHorizontal()
  const edges = nodes.flatMap(target => target.needs.flatMap(need => (byKey.get(need) ?? []).map(source => ({
    source: source.id,
    target: target.id,
    critical: criticalIds.has(source.id) && criticalIds.has(target.id),
    path: String(connector({ source: [source.x + 232, source.y + 33], target: [target.x, target.y + 33] })),
  }))))

  const knownStarts = timed.flatMap(node => node.queued !== null ? [node.queued] : node.started !== null ? [node.started] : [])
  const origin = knownStarts.length ? Math.min(...knownStarts) : 0
  const end = Math.max(origin, ...timed.map(node => node.end ?? node.started ?? node.queued ?? origin))
  const elapsed = end - origin
  const timeScale = scaleLinear().domain([0, Math.max(1000, elapsed)]).range([0, 620]).clamp(true)
  const timeline = nodes.map((node, index) => {
    const queued = node.queued ?? node.started
    const start = node.started ?? node.end ?? queued
    return {
      ...node,
      rowY: 48 + index * 46,
      queueX: Number(timeScale((queued ?? origin) - origin)),
      queueWidth: queued !== null && start !== null ? Math.max(0, Number(timeScale(start - origin)) - Number(timeScale(queued - origin))) : 0,
      runX: Number(timeScale((start ?? origin) - origin)),
      runWidth: node.started !== null && node.end !== null ? Math.max(2, Number(timeScale(node.end - origin)) - Number(timeScale(node.started - origin))) : 0,
    }
  })
  const ticks = timeScale.ticks(5).map((value: number) => ({ x: 260 + Number(timeScale(value)), label: millisFor(value) }))
  return {
    nodes, edges, width, height, timeline, ticks,
    timelineHeight: Math.max(140, nodes.length * 46 + 70),
    hasTiming: knownStarts.length > 0,
    criticalNames: path.totalMs > 0 && nodes.length > 1 ? path.nodes.map(node => node.name) : [],
    criticalTotal: millisFor(path.totalMs),
    criticalWait: millisFor(path.waitMs),
    finished: rows.filter(row => isTerminalJob(row.state)).length,
    failed: rows.filter(row => row.state === 'failed').length,
    running: rows.filter(row => row.state === 'running').length,
    elapsed: knownStarts.length && timed.some(node => node.end !== null) ? millisFor(elapsed) : '',
    layers: layers.map((layer, index) => ({ x: 24 + index * 280, label: index === 0 ? 'Start' : `Stage ${index + 1}`, count: layer.nodes.length })),
  }
}
