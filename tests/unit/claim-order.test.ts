import { describe, expect, test } from 'bun:test'
import { defaultBranchFirst, effectivePriority } from '../../app/Actions/Runner/claim'

describe('the default branch first, at equal priority', () => {
  test('concatenates the branch name the way each dialect does', () => {
    expect(defaultBranchFirst(false)).toBe(`CASE WHEN workflow_runs.event_ref = 'refs/heads/' || repositories.default_branch THEN 0 ELSE 1 END ASC`)
    // In MySQL `||` is OR, which would compare the ref with a boolean.
    expect(defaultBranchFirst(true)).toBe(`CASE WHEN workflow_runs.event_ref = CONCAT('refs/heads/', repositories.default_branch) THEN 0 ELSE 1 END ASC`)
  })
})

describe('a job that asked to go last', () => {
  test('competes at 0 once it has been claimable for the starvation window, by either clock', () => {
    const sql = effectivePriority(new Date('2026-10-19T20:40:00.000Z'), 30)
    expect(sql).toBe(`CASE WHEN workflow_jobs.priority < 0 AND ((workflow_jobs.queued_at IS NOT NULL AND workflow_jobs.queued_at < '2026-10-19T20:10:00.000Z') OR (workflow_jobs.queued_at IS NULL AND workflow_jobs.created_at < '2026-10-19 20:10:00')) THEN 0 ELSE workflow_jobs.priority END DESC`)
  })
})
