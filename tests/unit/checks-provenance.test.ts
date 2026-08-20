// Who ran a check, when it was not this instance.
//
// An external CI adapter reports into the same table this instance's own runs
// report into, which is the point - one list, one rollup, one branch rule. What
// must not follow is a forge rendering somebody else's build as its own: that
// is claiming work it did not do, and it is also the first thing anybody needs
// when a check is wrong, because "where do I go and look" has no answer on a
// row that does not say.

import { describe, expect, test } from 'bun:test'
import { entryForMissing, entryFromRun, entryFromStatus } from '../../app/Actions/Checks/panel'

const required = new Set<string>()

describe('a check an adapter reported', () => {
  test('names the system that ran it', () => {
    const entry = entryFromRun({
      name: 'buildkite/pipeline',
      status: 'completed',
      conclusion: 'success',
      provider: 'buildkite',
      head_sha: 'a'.repeat(40),
      details_url: 'https://buildkite.test/builds/12',
    }, { required, headSha: 'a'.repeat(40) })

    expect(entry.provider).toBe('buildkite')
    // And the link back, which is what the provider name is for.
    expect(entry.detailsUrl).toContain('buildkite.test')
  })
})

describe('a check this instance produced', () => {
  test('names nobody, because there is nobody else to name', () => {
    /*
     * Empty rather than the instance's own name: a badge on every row is a
     * badge nobody reads, and the distinction being drawn is "this came from
     * somewhere else", not "this came from somewhere".
     */
    const entry = entryFromRun({
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      provider: null,
      head_sha: 'a'.repeat(40),
    }, { required, headSha: 'a'.repeat(40) })

    expect(entry.provider).toBe('')
  })

  test('and neither does a commit status or a check that never reported', () => {
    // A status carries its reporter in its context by convention rather than
    // in a column, so there is nothing to name separately.
    expect(entryFromStatus({ context: 'ci/circleci', state: 'success' }, required).provider).toBe('')

    // And nothing reported the missing one, by definition.
    expect(entryForMissing('coverage').provider).toBe('')
  })
})
