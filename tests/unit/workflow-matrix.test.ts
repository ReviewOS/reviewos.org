// Matrix expansion, against GitHub's own documented behaviour.
//
// This is the part of workflow syntax that looks simple and is not, and getting
// it wrong is never a parse error: it is the wrong number of jobs, or the right
// number with one carrying the wrong Node version, which reads as a test suite
// that passes when it should not.
//
// Every case below is a rule from Actions' documentation, written as the
// workflow somebody would actually have.

import { describe, expect, test } from 'bun:test'
import { combinationLabel, expandMatrix, MAX_COMBINATIONS, matches, product } from '../../app/Actions/Workflow/matrix'

describe('the product', () => {
  test('is every combination, with the last key varying fastest', () => {
    // The order is observable: it is the order jobs appear in a run, and
    // Actions' order is what somebody comparing two forges notices first.
    const { combinations } = expandMatrix({ os: ['ubuntu', 'windows'], node: [20, 22] })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'ubuntu', node: 22 },
      { os: 'windows', node: 20 },
      { os: 'windows', node: 22 },
    ])
  })

  test('a scalar is an axis of one, not a mistake', () => {
    // `matrix: { os: ubuntu }` is a workflow that runs once. Refusing it would
    // be stricter than Actions for no gain.
    expect(expandMatrix({ os: 'ubuntu', node: [20, 22] }).combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'ubuntu', node: 22 },
    ])
  })

  test('and no matrix at all is no combinations, which the caller reads as one plain job', () => {
    expect(expandMatrix(undefined).combinations).toEqual([])
    expect(expandMatrix({}).combinations).toEqual([])
  })
})

describe('exclude', () => {
  test('removes a combination it names in full', () => {
    const { combinations } = expandMatrix({
      os: ['ubuntu', 'windows'],
      node: [20, 22],
      exclude: [{ os: 'windows', node: 20 }],
    })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'ubuntu', node: 22 },
      { os: 'windows', node: 22 },
    ])
  })

  test('and a partial filter removes every combination that matches it', () => {
    // `exclude: [{ os: windows }]` is how a workflow drops a platform, and
    // reading it as "only the combination that is exactly { os: windows }"
    // would silently keep every Windows job.
    const { combinations } = expandMatrix({
      os: ['ubuntu', 'windows'],
      node: [20, 22],
      exclude: [{ os: 'windows' }],
    })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'ubuntu', node: 22 },
    ])
  })
})

describe('include', () => {
  test('extends every combination it fits without overwriting anything', () => {
    // The documented case: adding a value to the jobs that already match.
    const { combinations } = expandMatrix({
      os: ['ubuntu', 'windows'],
      node: [20],
      include: [{ os: 'ubuntu', experimental: true }],
    })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20, experimental: true },
      { os: 'windows', node: 20 },
    ])
  })

  test('and is appended as its own job when it would overwrite one', () => {
    // An entry that changes a value is not an extension of that combination;
    // it is a new one. This is how a workflow adds "and also node 23 on
    // ubuntu" without adding 23 to every platform.
    const { combinations } = expandMatrix({
      os: ['ubuntu', 'windows'],
      node: [20],
      include: [{ os: 'ubuntu', node: 23 }],
    })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'windows', node: 20 },
      { os: 'ubuntu', node: 23 },
    ])
  })

  /*
   * Order matters between the two, and Actions is explicit: exclude first.
   * A workflow that excludes a combination and then includes it back expects
   * the include to win, and reversing this drops the job silently.
   */
  test('survives an exclude that names the same combination', () => {
    const { combinations } = expandMatrix({
      os: ['ubuntu', 'windows'],
      node: [20],
      exclude: [{ os: 'windows' }],
      include: [{ os: 'windows', node: 20 }],
    })

    expect(combinations).toEqual([
      { os: 'ubuntu', node: 20 },
      { os: 'windows', node: 20 },
    ])
  })

  test('on a job with no matrix keys, it is the whole matrix', () => {
    // `strategy: { matrix: { include: [...] } }` is how an explicit list of
    // jobs is spelled, and the product of no axes is nothing.
    const { combinations } = expandMatrix({
      include: [{ name: 'lint' }, { name: 'typecheck' }],
    })

    expect(combinations).toEqual([{ name: 'lint' }, { name: 'typecheck' }])
  })
})

describe('values that are not scalars', () => {
  test('an object value compares by shape, so exclude finds it', () => {
    // `{ node: 20, experimental: true }` as a matrix value is idiomatic, and
    // comparing by identity would make every exclude miss.
    const { combinations } = expandMatrix({
      target: [{ node: 20 }, { node: 22 }],
      exclude: [{ target: { node: 20 } }],
    })

    expect(combinations).toEqual([{ target: { node: 22 } }])
  })

  test('and matches is the same rule the filters use', () => {
    expect(matches({ os: 'ubuntu', node: 20 }, { os: 'ubuntu' })).toBe(true)
    expect(matches({ os: 'ubuntu', node: 20 }, { os: 'ubuntu', node: 22 })).toBe(false)
    expect(matches({ os: 'ubuntu' }, { node: 20 })).toBe(false)
  })
})

describe('the ceiling', () => {
  test('a matrix past it is cut, and says so rather than starting 4,000 jobs', () => {
    const { combinations, problem } = expandMatrix({
      a: Array.from({ length: 20 }, (_, at) => at),
      b: Array.from({ length: 20 }, (_, at) => at),
    })

    expect(combinations).toHaveLength(MAX_COMBINATIONS)
    expect(problem).toContain('400 jobs')
    expect(problem).toContain('256')
  })

  test('and one inside it says nothing', () => {
    expect(expandMatrix({ os: ['ubuntu', 'windows'] }).problem).toBeUndefined()
  })
})

describe('the label', () => {
  test('is the values, in the matrix key order, the way Actions writes it', () => {
    // `build (ubuntu-latest, 20)`. It reads better than `os=…, node=…` at the
    // width a job list has, and it is what somebody scanning a failed run
    // already knows.
    expect(combinationLabel({ os: 'ubuntu-latest', node: 20 })).toBe('ubuntu-latest, 20')
    expect(combinationLabel({ target: { node: 22 } })).toBe('{"node":22}')
    expect(combinationLabel({})).toBe('')
  })
})

describe('the product helper on its own', () => {
  test('is empty-safe, because a job with no axes still has to produce something', () => {
    expect(product([])).toEqual([{}])
    expect(product([['os', []]])).toEqual([])
  })
})
