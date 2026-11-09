import { describe, expect, test } from 'bun:test'
import { buildRunChart } from '../../resources/functions/runChart'

const stamp = (seconds: number) => new Date(Date.UTC(2026, 10, 8) + seconds * 1000).toISOString()

describe('the run chart snapshot', () => {
  test('separates queueing from execution on one shared elapsed-time axis', () => {
    const chart = buildRunChart([
      { id: 1, job_id: 'build', state: 'succeeded', queued_at: stamp(0), started_at: stamp(10), finished_at: stamp(30) },
      { id: 2, job_id: 'test', state: 'failed', needs: 'build', queued_at: stamp(30), started_at: stamp(40), finished_at: stamp(60) },
    ])
    expect(chart.timeline[0].waitMs).toBe(10_000)
    expect(chart.timeline[0].runMs).toBe(20_000)
    expect(chart.timeline[1].queueX).toBe(310)
    expect(chart.timeline[1].runX).toBeCloseTo(413.333, 2)
    expect(chart.criticalNames).toEqual(['build', 'test'])
    expect(chart.finished).toBe(2)
    expect(chart.failed).toBe(1)
    expect(chart.edges[0].path).toMatch(/^M[\d.,C-]+$/)
  })

  test('does not invent a zero duration from an incomplete finished-job timestamp', () => {
    const chart = buildRunChart([
      { id: 1, job_id: 'cancelled', state: 'cancelled', queued_at: stamp(0) },
      { id: 2, job_id: 'quick', state: 'succeeded', started_at: stamp(0), finished_at: new Date(Date.parse(stamp(0)) + 400) },
    ])
    expect(chart.nodes[0].timing).toBe('Timing not reported')
    expect(chart.nodes[0].hasTiming).toBe(false)
    expect(chart.nodes[1].timing).toBe('400ms execution')
    expect(chart.elapsed).toBe('400ms')
  })

  test('connects every matrix prerequisite rather than only the last matching name', () => {
    const chart = buildRunChart([
      { id: 1, job_id: 'test', name: 'Test on Linux', state: 'succeeded' },
      { id: 2, job_id: 'test', name: 'Test on macOS', state: 'succeeded' },
      { id: 3, job_id: 'deploy', state: 'queued', needs: 'test' },
    ])
    expect(chart.edges.map(edge => [edge.source, edge.target])).toEqual([[1, 3], [2, 3]])
    expect(chart.hasTiming).toBe(false)
    expect(chart.criticalNames).toEqual([])
    expect(chart.nodes.every(node => !node.critical)).toBe(true)
  })

  test('keeps missing timings unknown and takes live timings from one clock snapshot', () => {
    const chart = buildRunChart([
      { id: 1, job_id: 'live', state: 'running', queued_at: stamp(0), started_at: stamp(10) },
      { id: 2, job_id: 'waiting', state: 'queued', queued_at: stamp(20) },
      { id: 3, job_id: 'skip', state: 'skipped' },
      { id: 4, job_id: 'invalid', state: 'succeeded', queued_at: 'not a date' },
    ], Date.parse(stamp(60)))
    expect(chart.timeline[0].runMs).toBe(50_000)
    expect(chart.timeline[1].waitMs).toBe(40_000)
    expect(chart.timeline[1].runWidth).toBe(0)
    expect(chart.timeline[2].hasTiming).toBe(false)
    expect(chart.timeline[3].hasTiming).toBe(false)
    expect(chart.running).toBe(1)
    expect(chart.finished).toBe(2)
    expect(chart.timeline.every(node => Number.isFinite(node.queueX) && Number.isFinite(node.runWidth))).toBe(true)
  })
})
