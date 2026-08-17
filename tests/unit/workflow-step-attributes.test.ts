// `skip`, `soft-fail` and `branches`: three of Buildkite's step attributes.
//
// Each decides in a different place, and where is the interesting part. `skip`
// and `branches` decide at dispatch, because they say whether a job should
// exist in this run at all - and a job that will never run should read as
// skipped from the first second rather than sit in the queue looking like work
// nobody has got to, which is how somebody ends up investigating a runner.
// `soft-fail` decides at the report, because it keys on an exit status that
// does not exist until the job has failed.

import { describe, expect, test } from 'bun:test'
import { branchDecision, skipDecision, softFailOutcome } from '../../app/Actions/Workflow/stepAttributes'
import { branchesFrom, parseWorkflow, skipFrom, softFailFrom } from '../../app/Actions/Workflow/parse'

describe('reading them', () => {
  test('all three survive parsing, on the job', () => {
    const parsed = parseWorkflow(`
name: ci
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    reviewos:
      soft-fail: [1]
      branches: [main, '!wip/*']
    steps:
      - run: ./lint
  legacy:
    runs-on: ubuntu-latest
    reviewos:
      skip: The vendor API is down until Tuesday.
    steps:
      - run: ./legacy
`)

    expect(parsed.ok).toBe(true)

    const [lint, legacy] = parsed.workflow?.jobs ?? []

    expect(lint!.softFail).toEqual({ any: false, statuses: [1] })
    expect(lint!.branches).toEqual(['main', '!wip/*'])
    expect(legacy!.skip).toBe('The vendor API is down until Tuesday.')
  })

  test('`skip: true` gets a sentence anyway', () => {
    // The reason is the difference between a skipped job somebody can decide
    // about in three weeks and a commented-out block nobody reads.
    expect(skipFrom(true)).toContain('Skipped')
    expect(skipFrom('because')).toBe('because')
    expect(skipFrom(false)).toBeNull()
  })

  test('`soft-fail` reads both shapes people write', () => {
    expect(softFailFrom(true)).toEqual({ any: true, statuses: [] })
    expect(softFailFrom([1, 2])).toEqual({ any: false, statuses: [1, 2] })

    // Buildkite's own long form, which is a list of `exit-status` records.
    expect(softFailFrom([{ 'exit-status': 137 }])).toEqual({ any: false, statuses: [137] })
    expect(softFailFrom(undefined)).toBeNull()
  })

  test('and `branches` is a list, negation kept as written', () => {
    expect(branchesFrom(['main', '!wip'])).toEqual(['main', '!wip'])
    expect(branchesFrom('main')).toEqual(['main'])
  })
})

describe('branches', () => {
  test('an inclusion list runs only on those branches', () => {
    expect(branchDecision(['main'], 'refs/heads/main').run).toBe(true)

    const other = branchDecision(['main'], 'refs/heads/spike')

    expect(other.run).toBe(false)
    // Named, because a job that quietly did not run on the branch somebody is
    // working on reads as a broken pipeline.
    expect(other.reason).toContain('spike')
  })

  test('an exclusion beats an inclusion', () => {
    /*
     * The rule every other tool with both follows, and the safer direction:
     * `['*', '!release/*']` means "not release", and reading it the other way
     * would run a deploy on exactly the branch it was told to avoid.
     */
    expect(branchDecision(['*', '!release/*'], 'refs/heads/release/2.1').run).toBe(false)
    expect(branchDecision(['*', '!release/*'], 'refs/heads/main').run).toBe(true)
  })

  test('exclusions alone mean everywhere else', () => {
    expect(branchDecision(['!wip/*'], 'refs/heads/main').run).toBe(true)
    expect(branchDecision(['!wip/*'], 'refs/heads/wip/thing').run).toBe(false)
  })

  test('a tag is matched by its name, and no list means everywhere', () => {
    expect(branchDecision(['v*'], 'refs/tags/v1.2.0').run).toBe(true)
    expect(branchDecision([], 'refs/heads/anything').run).toBe(true)
  })
})

describe('skip', () => {
  test('is the reason, straight through to the run', () => {
    const decision = skipDecision('The vendor API is down until Tuesday.')

    expect(decision.run).toBe(false)
    expect(decision.reason).toBe('The vendor API is down until Tuesday.')
  })

  test('and a job with no skip runs', () => {
    expect(skipDecision(null)).toEqual({ run: true, reason: '' })
  })
})

describe('soft-fail', () => {
  test('tolerates any failure when the workflow says so', () => {
    expect(softFailOutcome({ any: true, statuses: [] }, 1).tolerated).toBe(true)
  })

  test('and only the named statuses when it names them', () => {
    /*
     * The list is what earns the attribute its place: a linter exiting 1 on
     * findings is a soft failure, and the same linter exiting 127 because it
     * is not installed is a broken pipeline wearing a green tick.
     */
    expect(softFailOutcome({ any: false, statuses: [1] }, 1).tolerated).toBe(true)

    const refused = softFailOutcome({ any: false, statuses: [1] }, 127)

    expect(refused.tolerated).toBe(false)
    expect(refused.reason).toContain('127')
  })

  test('a failure with no exit status is not tolerated by a status list', () => {
    // A lost runner or a timeout is exactly the failure a list of statuses was
    // not written for, and tolerating "we do not know why" is how a narrow
    // allowance becomes a blanket one.
    const outcome = softFailOutcome({ any: false, statuses: [1] }, null)

    expect(outcome.tolerated).toBe(false)
    expect(outcome.reason).toContain('without an exit status')
  })

  test('and a job that did not ask for it is untouched', () => {
    expect(softFailOutcome(null, 1)).toEqual({ tolerated: false, reason: '' })
  })
})

describe('allow-dependency-failure', () => {
  test('a job can run after a dependency failed, on purpose', () => {
    /*
     * The "publish the results whatever happened" stage. It reaches the graph
     * as the same `continueOnFailure` flag a `wait:` barrier's
     * `continue-on-failure` sets - one rule, one path, rather than two spellings
     * that disagree with each other a year later.
     */
    const parsed = parseWorkflow(`
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: ./test
  publish-results:
    runs-on: ubuntu-latest
    needs: [test]
    reviewos:
      allow-dependency-failure: true
    steps:
      - run: ./publish
`)

    expect(parsed.ok).toBe(true)

    const publish = parsed.workflow?.jobs?.find(one => one.id === 'publish-results')

    expect(publish?.allowDependencyFailure).toBe(true)
    expect(publish?.settings.continueOnFailure).toBe(true)
  })

  test('and a job that did not ask keeps the ordinary rule', () => {
    const parsed = parseWorkflow(`
name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`)

    const build = parsed.workflow?.jobs?.[0]

    expect(build?.allowDependencyFailure).toBe(false)
    expect(build?.settings.continueOnFailure).toBeUndefined()
  })
})
