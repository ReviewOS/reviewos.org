// One combination of a matrix, singled out.
//
// The useful matrix is never the full cross product: one combination is
// known-broken and should not run, another is expected to fail and should not
// fail the run. Actions can say the first with `exclude` and cannot say the
// second at all - `continue-on-error` is per job, so tolerating the nightly
// Node version means tolerating every version.

import { describe, expect, test } from 'bun:test'
import { adjustmentFor } from '../../app/Actions/Workflow/matrix'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

function jobs(source: string): any[] {
  const result = parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')

  if (result.errors.length > 0)
    throw new Error(result.errors.map(error => error.message).join('; '))

  return result.workflow!.jobs
}

function errorsIn(source: string): string[] {
  return parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')
    .errors.map(error => error.message)
}

describe('matching a combination', () => {
  const adjustments = [
    { with: { os: 'windows' }, softFail: true },
    { with: { node: 24, os: 'windows' }, skip: 'Node 24 does not build on Windows yet.' },
  ]

  test('a partial match is a match', () => {
    // `{ os: windows }` names every Windows combination, which is what somebody
    // writing it means.
    expect(adjustmentFor({ os: 'windows', node: 20 }, adjustments)?.softFail).toBe(true)
    expect(adjustmentFor({ os: 'linux', node: 20 }, adjustments)).toBeNull()
  })

  test('and the last match wins, so a narrow entry overrides a broad one', () => {
    /*
     * The rule people expect from a list of overrides: tolerate Windows, except
     * this one combination which does not run at all.
     */
    expect(adjustmentFor({ os: 'windows', node: 24 }, adjustments)?.skip).toContain('does not build')
  })

  test('an entry with no values is ignored rather than applied to everything', () => {
    // Somebody writing a job-level setting in the wrong place. Reading it as
    // "all combinations" would tolerate failures across a whole matrix.
    expect(adjustmentFor({ os: 'linux' }, [{ with: {}, softFail: true }])).toBeNull()
  })
})

describe('reading them off a job', () => {
  test('skip and soft-fail come through, with skip carrying a reason', () => {
    const [test_] = jobs(`jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    reviewos:
      adjustments:
        - with: { node: 24 }
          soft-fail: true
        - with: { node: 22 }
          skip: Waiting on the upstream fix.
    steps:
      - run: bun test
`)

    expect(test_!.adjustments).toEqual([
      { with: { node: 24 }, skip: null, softFail: true },
      { with: { node: 22 }, skip: 'Waiting on the upstream fix.', softFail: false },
    ])
  })

  test('`skip: true` gets a reason written for it', () => {
    /*
     * A skipped row with no explanation is the worst row on a run page, and
     * `skip: true` is what people write. The row says something rather than
     * nothing.
     */
    const [one] = jobs(`jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    reviewos:
      adjustments:
        - with: { node: 22 }
          skip: true
    steps:
      - run: bun test
`)

    expect(String(one!.adjustments[0].skip)).toContain('turned off by an adjustment')
  })

  test('an entry with no `with:` is refused', () => {
    expect(errorsIn(`jobs:
  test:
    runs-on: ubuntu-latest
    reviewos:
      adjustments:
        - soft-fail: true
    steps:
      - run: bun test
`).join(' ')).toContain('does not say which combination it is for')
  })

  test('and something that is not a list at all', () => {
    expect(errorsIn(`jobs:
  test:
    runs-on: ubuntu-latest
    reviewos:
      adjustments: yes
    steps:
      - run: bun test
`).join(' ')).toContain('is not a list')
  })
})
