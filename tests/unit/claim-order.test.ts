import { describe, expect, test } from 'bun:test'
import { defaultBranchFirst } from '../../app/Actions/Runner/claim'

describe('the default branch first, at equal priority', () => {
  test('concatenates the branch name the way each dialect does', () => {
    expect(defaultBranchFirst(false)).toBe(`CASE WHEN workflow_runs.event_ref = 'refs/heads/' || repositories.default_branch THEN 0 ELSE 1 END ASC`)
    // In MySQL `||` is OR, which would compare the ref with a boolean.
    expect(defaultBranchFirst(true)).toBe(`CASE WHEN workflow_runs.event_ref = CONCAT('refs/heads/', repositories.default_branch) THEN 0 ELSE 1 END ASC`)
  })
})
