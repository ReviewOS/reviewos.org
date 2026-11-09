import { describe, expect, test } from 'bun:test'
import { jobTiming } from '../../resources/functions/jobTiming'
import { graphRelations } from '../../resources/functions/runGraph'
import { compareRunJobs, failureSummaries } from '../../resources/functions/runDiagnostics'

const stamp = (ms: number) => new Date(ms).toISOString()

describe('allocation timing', () => {
  test('a gate contributes waiting, never execution or a machine queue', () => {
    const timing = jobTiming({ kind: 'block', state: 'paused', started_at: stamp(1000) }, 61_000)
    expect(timing).toMatchObject({ runKnown: true, runMs: 0, waitKnown: false, holdKnown: true, holdMs: 60_000 })
  })
  test('sleep and subsequent queues are excluded from resumed execution', () => {
    const row = { orchestrator: true, state: 'running', started_at: stamp(1000), queued_at: stamp(80_000), execution_ms: 9000, execution_started_at: stamp(85_000), queue_ms: 6000, first_queue_ms: 1000 }
    expect(jobTiming(row, 90_000)).toMatchObject({ runMs: 14_000, waitMs: 6000, holdMs: 70_000 })
    expect(jobTiming({ ...row, state: 'queued', execution_started_at: null }, 90_000)).toMatchObject({ runMs: 9000, holdMs: 65_000, waitMs: 16_000 })
    expect(jobTiming({ ...row, state: 'succeeded', finished_at: stamp(90_000) }, 999_000).runMs).toBe(14_000)
  })
  test('a sleeping attempt freezes execution while its wait grows', () => {
    const row = { orchestrator: true, state: 'sleeping', started_at: stamp(1000), execution_ms: 9000, execution_started_at: null, queue_ms: 1000, first_queue_ms: 1000 }
    expect(jobTiming(row, 60_000)).toMatchObject({ runMs: 9000, holdMs: 50_000 })
    expect(jobTiming(row, 90_000)).toMatchObject({ runMs: 9000, holdMs: 80_000 })
  })
  test('historical orchestrators do not claim their entire sleep was execution', () => {
    expect(jobTiming({ orchestrator: true, state: 'succeeded', started_at: stamp(1000), finished_at: stamp(100_000) })).toMatchObject({ runKnown: false, runMs: 0, waitKnown: false })
  })
})

test('graph selection follows transitive prerequisites and dependants without cycling', () => {
  const edges = [{ source: 1, target: 2 }, { source: 2, target: 3 }, { source: 3, target: 4 }, { source: 4, target: 3 }]
  const relations = graphRelations(edges, 2)
  expect([...relations.prerequisites]).toEqual([1])
  expect([...relations.dependants]).toEqual([3, 4])
})

test('comparison matches matrix identities, distinguishes new jobs, and leaves unknown durations unavailable', () => {
  const old = [{ id: 1, job_id: 'test', matrix_values: '{"os":"linux","version":1}', state: 'succeeded', queued_at: stamp(1000), started_at: stamp(2000), finished_at: stamp(12_000) }]
  const current = [{ id: 2, job_id: 'test', matrix_values: '{"version":1,"os":"linux"}', state: 'failed', queued_at: stamp(1000), started_at: stamp(4000), finished_at: stamp(24_000) }, { id: 3, job_id: 'new', state: 'succeeded' }]
  expect(compareRunJobs(current, old)).toMatchObject([{ status: 'Now failing', execution: '10s slower', queue: '2.0s slower', regression: true }, { status: 'New job', execution: 'New job' }])
  expect(compareRunJobs([{ ...current[0], finished_at: null }], old)[0]?.execution).toBe('Not available')
})

test('failure summary uses the explicit failed step and current attempt output', () => {
  const jobs = [{ id: 1, job_id: 'test', name: 'Tests', state: 'failed', attempt: 2 }]
  const steps = [{ id: 10, workflow_job_id: 1, state: 'failed', name: 'Integration', exit_code: 7, error: 'Connection refused' }]
  const logs = [{ workflow_job_id: 1, attempt: 1, content: 'old output' }, { workflow_job_id: 1, attempt: 2, content: 'setup\nerror: connection refused\ncleanup' }]
  expect(failureSummaries(jobs, steps, logs)[0]).toMatchObject({ step: 'Integration', exit: 7, error: 'Connection refused', anchor: 'step-10', excerpt: 'setup\nerror: connection refused\ncleanup' })
})

test('durable calls compare by journal identity rather than their per-run storage key', () => {
  const before = { id: 11, job_id: 'call-101', comparison_key: 'journal:job:3:Evaluate', name: 'Evaluate', state: 'succeeded', started_at: stamp(1000), finished_at: stamp(11_000) }
  const now = { ...before, id: 12, job_id: 'call-202', finished_at: stamp(21_000) }
  expect(compareRunJobs([now], [before])[0]).toMatchObject({ status: 'Existing job', execution: '10s slower' })
})
