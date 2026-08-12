// Combining check runs into the answer the merge button needs.
//
// Both directions of error are real: showing green while something is red
// merges unverified code, and treating a skipped or neutral check as a failure
// blocks every pull request on a path-filtered workflow that had nothing to say.

import { describe, expect, test } from 'bun:test'
import type { CheckRun } from '../../app/Actions/Checks/status'
import {
  combinedState,
  latestRuns,
  requirementsSatisfied,
  requirementSummary,
  runPassed,
  staleRunsFor,
  statusAsRun,
} from '../../app/Actions/Checks/status'

function run(name: string, conclusion: CheckRun['conclusion'], startedAt = 0, status: CheckRun['status'] = 'completed'): CheckRun {
  return { name, status, conclusion, startedAt }
}

const running = (name: string, startedAt = 0): CheckRun => ({ name, status: 'in_progress', conclusion: null, startedAt })

describe('latestRuns', () => {
  test('keeps the most recent run of a check', () => {
    const runs = [run('build', 'failure', 100), run('build', 'success', 200)]

    expect(latestRuns(runs)).toEqual([run('build', 'success', 200)])
  })

  test('a retry replaces the earlier failure rather than joining it', () => {
    // Otherwise one failed attempt keeps a commit red forever.
    expect(combinedState([run('build', 'failure', 1), run('build', 'success', 2)])).toBe('success')
  })

  test('keeps every distinct check', () => {
    expect(latestRuns([run('build', 'success'), run('lint', 'success')])).toHaveLength(2)
  })

  test('sorts by name, so the list does not reshuffle between loads', () => {
    const names = latestRuns([run('lint', 'success'), run('build', 'success')]).map(r => r.name)

    expect(names).toEqual(['build', 'lint'])
  })

  test('nothing reported is an empty list', () => {
    expect(latestRuns([])).toEqual([])
  })
})

describe('runPassed', () => {
  test('success passes', () => {
    expect(runPassed(run('build', 'success'))).toBe(true)
  })

  test('neutral and skipped pass, because they found no problem', () => {
    expect(runPassed(run('build', 'neutral'))).toBe(true)
    expect(runPassed(run('build', 'skipped'))).toBe(true)
  })

  test('failure and timeout do not', () => {
    expect(runPassed(run('build', 'failure'))).toBe(false)
    expect(runPassed(run('build', 'timed_out'))).toBe(false)
    expect(runPassed(run('build', 'action_required'))).toBe(false)
  })

  test('an unfinished run has not passed', () => {
    expect(runPassed(running('build'))).toBe(false)
  })
})

describe('combinedState', () => {
  test('all green is success', () => {
    expect(combinedState([run('build', 'success'), run('lint', 'success')])).toBe('success')
  })

  test('one failure wins over any number of successes', () => {
    expect(combinedState([run('build', 'success'), run('lint', 'failure')])).toBe('failure')
  })

  test('a failure wins even while other checks are still running', () => {
    expect(combinedState([running('build'), run('lint', 'failure')])).toBe('failure')
  })

  test('anything unfinished is pending', () => {
    expect(combinedState([run('build', 'success'), running('lint')])).toBe('pending')
  })

  test('a cancelled run is pending, not a failure', () => {
    // Something will report again; the commit is not condemned.
    expect(combinedState([run('build', 'cancelled')])).toBe('pending')
  })

  test('a stale run is pending', () => {
    expect(combinedState([run('build', 'stale')])).toBe('pending')
  })

  test('no checks at all is neutral, not success', () => {
    expect(combinedState([])).toBe('neutral')
  })

  test('a skipped check does not hold the commit back', () => {
    expect(combinedState([run('build', 'success'), run('docs', 'skipped')])).toBe('success')
  })
})

describe('requirementsSatisfied', () => {
  test('no requirements is satisfied', () => {
    expect(requirementsSatisfied([run('build', 'failure')], []).satisfied).toBe(true)
  })

  test('a required check that passed satisfies', () => {
    expect(requirementsSatisfied([run('build', 'success')], ['build']).satisfied).toBe(true)
  })

  test('a required check that failed does not', () => {
    const result = requirementsSatisfied([run('build', 'failure')], ['build'])

    expect(result.satisfied).toBe(false)
    expect(result.failing).toEqual(['build'])
  })

  test('a check nobody required is ignored, however red it is', () => {
    // An experimental job must not block a merge.
    const result = requirementsSatisfied([run('build', 'success'), run('experimental', 'failure')], ['build'])

    expect(result.satisfied).toBe(true)
  })

  test('a required check still running is pending', () => {
    const result = requirementsSatisfied([running('build')], ['build'])

    expect(result.pending).toEqual(['build'])
    expect(result.missing).toEqual([])
  })

  test('a required check that never reported is missing, not pending', () => {
    // Pending resolves itself; missing means the workflow is not wired up.
    const result = requirementsSatisfied([run('lint', 'success')], ['build'])

    expect(result.missing).toEqual(['build'])
    expect(result.pending).toEqual([])
  })

  test('a cancelled required check is pending', () => {
    expect(requirementsSatisfied([run('build', 'cancelled')], ['build']).pending).toEqual(['build'])
  })

  test('a required check that was skipped satisfies', () => {
    expect(requirementsSatisfied([run('build', 'skipped')], ['build']).satisfied).toBe(true)
  })

  test('reports each category separately', () => {
    const result = requirementsSatisfied(
      [run('a', 'failure'), running('b')],
      ['a', 'b', 'c'],
    )

    expect(result.failing).toEqual(['a'])
    expect(result.pending).toEqual(['b'])
    expect(result.missing).toEqual(['c'])
  })

  test('a retried required check is judged on its latest run', () => {
    const result = requirementsSatisfied([run('build', 'failure', 1), run('build', 'success', 2)], ['build'])

    expect(result.satisfied).toBe(true)
  })
})

describe('requirementSummary', () => {
  test('says so when everything passed', () => {
    expect(requirementSummary(requirementsSatisfied([run('build', 'success')], ['build'])))
      .toContain('passed')
  })

  test('names the failing checks', () => {
    const summary = requirementSummary(requirementsSatisfied([run('build', 'failure')], ['build']))

    expect(summary).toContain('build')
    expect(summary).toContain('failed')
  })

  test('uses the singular for one failure', () => {
    expect(requirementSummary(requirementsSatisfied([run('build', 'failure')], ['build'])))
      .toContain('check failed')
  })

  test('distinguishes never-reported from still-running', () => {
    const missing = requirementSummary(requirementsSatisfied([], ['build']))
    const pending = requirementSummary(requirementsSatisfied([running('build')], ['build']))

    expect(missing).toContain('first time')
    expect(pending).not.toContain('first time')
  })
})

describe('staleRunsFor', () => {
  test('marks runs from a superseded commit', () => {
    // Leaving them green is how a force push slips past a required check.
    const runs = [run('build', 'success'), run('lint', 'success')]

    expect(staleRunsFor(runs, 'new', ['old', 'new'])).toEqual([0])
  })

  test('leaves runs on the current head alone', () => {
    expect(staleRunsFor([run('build', 'success')], 'head', ['head'])).toEqual([])
  })

  test('does not re-mark something already stale', () => {
    expect(staleRunsFor([run('build', 'stale')], 'new', ['old'])).toEqual([])
  })
})


describe('a commit status satisfying a required check', () => {
  /*
   * A required check is a *name*, and a branch rule cannot know which of the
   * two reporting APIs answers to it. Until `statusAsRun` existed only
   * `check_runs` were consulted, so a repository requiring `ci/build` while its
   * CI posted `ci/build` as a commit status - the older API, and what most
   * existing integrations use - waited forever, and the page said the check had
   * never reported about one that had just reported.
   */
  test('counts, so CI posting statuses is not ignored forever', () => {
    const result = requirementsSatisfied(
      [statusAsRun({ context: 'ci/build', state: 'success', created_at: '2026-08-12T10:00:00Z' })],
      ['ci/build'],
    )

    expect(result.satisfied).toBe(true)
  })

  test('a failing status blocks the same way a failing run does', () => {
    const result = requirementsSatisfied(
      [statusAsRun({ context: 'ci/build', state: 'error', created_at: '2026-08-12T10:00:00Z' })],
      ['ci/build'],
    )

    expect(result.failing).toEqual(['ci/build'])
  })

  test('and a pending one is waited for rather than counted', () => {
    const result = requirementsSatisfied(
      [statusAsRun({ context: 'ci/build', state: 'pending', created_at: '2026-08-12T10:00:00Z' })],
      ['ci/build'],
    )

    expect(result.pending).toEqual(['ci/build'])
  })

  test('the newer of a status and a run under one name wins', () => {
    const result = requirementsSatisfied(
      [
        statusAsRun({ context: 'ci/build', state: 'error', created_at: '2026-08-12T10:00:00Z' }),
        run('ci/build', 'success', Date.parse('2026-08-12T10:05:00Z')),
      ],
      ['ci/build'],
    )

    // Same rule as two runs: the latest report is the answer, whichever API it
    // arrived through. Anything else makes the verdict depend on which table a
    // reporter happened to write to.
    expect(result.satisfied).toBe(true)
  })
})
