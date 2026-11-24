import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { defaultBranchFirst, effectivePriority } from '../../app/Actions/Runner/claim'

describe('the default branch first, at equal priority', () => {
  test('concatenates the branch name the way each dialect does', () => {
    expect(defaultBranchFirst(false)).toContain(`workflow_runs.event_ref = 'refs/heads/' || repositories.default_branch`)
    // In MySQL `||` is OR, which would compare the ref with a boolean.
    expect(defaultBranchFirst(true)).toContain(`workflow_runs.event_ref = CONCAT('refs/heads/', repositories.default_branch)`)
    expect(defaultBranchFirst(true)).not.toContain('||')
  })
})

const NOW = new Date('2026-11-24T12:00:00.000Z')

/** The claim's ORDER BY run against a real table: ids in the order they leave the queue. */
function order(jobs: Array<{ id: number, priority: number, waitedMinutes: number, queuedAt?: boolean }>, options?: Parameters<typeof effectivePriority>[1]): number[] {
  const db = new Database(':memory:')
  db.run('CREATE TABLE workflow_jobs (id INTEGER, priority INTEGER, queued_at TEXT, created_at TEXT)')
  for (const job of jobs) {
    const at = new Date(NOW.getTime() - job.waitedMinutes * 60_000).toISOString()
    // A job queued when its run was made has no queued_at; created_at is its ready time.
    db.run('INSERT INTO workflow_jobs VALUES (?, ?, ?, ?)', [job.id, job.priority, job.queuedAt === false ? null : at, at.slice(0, 19).replace('T', ' ')])
  }
  return db.query(`SELECT id FROM workflow_jobs ORDER BY ${effectivePriority(NOW, options)}, id ASC`).all().map((row: any) => row.id)
}

describe('a job that asked to go last', () => {
  test('competes at 0 once it has been claimable for the starvation window, by either clock', () => {
    expect(order([{ id: 1, priority: -10, waitedMinutes: 31 }, { id: 2, priority: 0, waitedMinutes: 1 }])).toEqual([1, 2])
    expect(order([{ id: 1, priority: -10, waitedMinutes: 31, queuedAt: false }, { id: 2, priority: 0, waitedMinutes: 1 }])).toEqual([1, 2])
    expect(order([{ id: 1, priority: -10, waitedMinutes: 29 }, { id: 2, priority: 0, waitedMinutes: 1 }])).toEqual([2, 1])
  })
})

describe('every job ages', () => {
  test('fresh work keeps its priority order', () => {
    expect(order([{ id: 1, priority: 5, waitedMinutes: 5 }, { id: 2, priority: 10, waitedMinutes: 1 }, { id: 3, priority: 20, waitedMinutes: 0 }])).toEqual([3, 2, 1])
  })

  test('a job that waited an hour stands level with fresh work that asked for 10 more, and is older', () => {
    // HQ, 2026-11-23: the screen capture at 10 behind a stream of fresh deploy jobs at 20.
    expect(order([{ id: 1, priority: 10, waitedMinutes: 61 }, { id: 2, priority: 20, waitedMinutes: 2 }])).toEqual([1, 2])
    expect(order([{ id: 1, priority: 10, waitedMinutes: 59 }, { id: 2, priority: 20, waitedMinutes: 2 }])).toEqual([2, 1])
  })

  test('a low priority waits at most (difference / 10) hours behind fresh work', () => {
    expect(order([{ id: 1, priority: 5, waitedMinutes: 125 }, { id: 2, priority: 20, waitedMinutes: 0 }])).toEqual([1, 2])
    expect(order([{ id: 1, priority: 5, waitedMinutes: 65 }, { id: 2, priority: 20, waitedMinutes: 0 }])).toEqual([2, 1])
  })

  test('a negative job ages from 0 after its starvation window', () => {
    expect(order([{ id: 1, priority: -10, waitedMinutes: 61 }, { id: 2, priority: 5, waitedMinutes: 0 }])).toEqual([1, 2])
  })

  test('aging stops after the last step', () => {
    // Eight hours is the most a wait adds (80); a job asking for 100 more stays ahead.
    expect(order([{ id: 1, priority: 0, waitedMinutes: 24 * 60 }, { id: 2, priority: 100, waitedMinutes: 0 }])).toEqual([2, 1])
    expect(order([{ id: 1, priority: 0, waitedMinutes: 24 * 60 }, { id: 2, priority: 79, waitedMinutes: 0 }])).toEqual([1, 2])
  })

  test('steps and windows are configurable', () => {
    expect(order([{ id: 1, priority: 0, waitedMinutes: 11 }, { id: 2, priority: 5, waitedMinutes: 0 }], { agingMinutes: 10, boost: 5, steps: 2 })).toEqual([1, 2])
    // A short step lifts ordinary work but never a negative job before its window.
    expect(order([{ id: 1, priority: -10, waitedMinutes: 11 }, { id: 2, priority: -5, waitedMinutes: 0 }], { agingMinutes: 10, boost: 5, steps: 2 })).toEqual([2, 1])
    expect(effectivePriority(NOW, { steps: 0 })).not.toContain(' + ')
  })
})
