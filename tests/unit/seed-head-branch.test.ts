import { describe, expect, it } from 'bun:test'
import { headBranchFor } from '../../database/seeders/RepositoryGit'

/**
 * A seeder re-runs, so the names it computes have to be fixed points.
 *
 * `RepositoryGit` derived a pull request's branch name from the column it then
 * wrote the name to, so every reseed appended the number once more. The tests
 * that matter here are the second and third: the first would pass against the
 * broken version too.
 */
describe('headBranchFor', () => {
  it('names a branch after the change, so two in one repository differ', () => {
    expect(headBranchFor('feature/card', 45)).toBe('feature/card-45')
  })

  it('returns the same name when handed its own output', () => {
    const once = headBranchFor('feature/card', 45)

    expect(headBranchFor(once, 45)).toBe(once)
    expect(headBranchFor(headBranchFor(once, 45), 45)).toBe(once)
  })

  it('collapses a name an earlier run compounded', () => {
    expect(headBranchFor('feature/card-45-45-45-45-45-45-45-45-45', 45)).toBe('feature/card-45')
  })

  it('leaves a number that is not this change alone', () => {
    expect(headBranchFor('release-12', 45)).toBe('release-12-45')
    expect(headBranchFor('v45-rework', 45)).toBe('v45-rework-45')
  })

  it('only strips a suffix, so a name that is just the number survives', () => {
    expect(headBranchFor('45', 45)).toBe('45-45')
  })

  it('falls back to a name when stripping leaves nothing', () => {
    expect(headBranchFor('-45', 45)).toBe('change-45')
    expect(headBranchFor('-45-45', 45)).toBe('change-45')
  })
})
