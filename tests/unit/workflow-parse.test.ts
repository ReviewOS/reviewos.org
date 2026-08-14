// Reading a GitHub Actions workflow file.
//
// The bar phase 15 sets is that somebody copies a working `.github/workflows`
// directory across and watches it go green, so what matters here is the file
// people already have rather than one written to pass. The fixture below is an
// ordinary CI workflow: a matrix, a needs edge, two `uses` steps, an `if`, and
// a concurrency group.
//
// This module had none of its own tests, which is how three of the things below
// were missing without anybody noticing: the `runs-on: { group, labels }` form
// refused a valid workflow outright, `concurrency:` was accepted and dropped -
// the exact failure the roadmap names Gitea for - and a matrix was parsed but
// never expanded, so a run could not say how many jobs were coming.

import { describe, expect, test } from 'bun:test'
import { concurrencyFrom, cyclicJobs, defaultsFrom, lineOf, parseWorkflow, runsOnFrom } from '../../app/Actions/Workflow/parse'

const ORDINARY = `
name: CI

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
  pull_request:
    types: [opened, synchronize]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

env:
  CI: true

defaults:
  run:
    shell: bash
    working-directory: ./app

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install
        run: bun install
        env:
          NODE_ENV: test
      - name: Test
        id: test
        run: bun test

  publish:
    runs-on: [self-hosted, linux]
    needs: [test]
    if: github.ref == 'refs/heads/main'
    steps:
      - run: bun run release
`

describe('an ordinary workflow', () => {
  const result = parseWorkflow(ORDINARY, '.github/workflows/ci.yml')

  test('parses without complaint', () => {
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.workflow?.name).toBe('CI')
  })

  test('reads its triggers, with the filters kept as written', () => {
    // Kept rather than compiled: deciding whether a push matches needs the
    // push, which the parser does not have.
    const triggers = result.workflow!.triggers

    expect(triggers.push?.branches).toEqual(['main'])
    expect(triggers.push?.pathsIgnore).toEqual(['docs/**'])
    expect(triggers.pullRequest?.types).toEqual(['opened', 'synchronize'])
    expect(triggers.pullRequestTarget).toBeNull()
  })

  test('and its jobs, in the order the file lists them', () => {
    const jobs = result.workflow!.jobs

    expect(jobs.map(job => job.id)).toEqual(['test', 'publish'])
    expect(jobs[1]!.needs).toEqual(['test'])
    expect(jobs[1]!.if).toBe(`github.ref == 'refs/heads/main'`)
    expect(jobs[1]!.runsOn).toEqual(['self-hosted', 'linux'])
  })

  test('expands the matrix, so a run can say how many jobs are coming', () => {
    const [test] = result.workflow!.jobs

    expect(test!.matrix).toEqual([{ node: 20 }, { node: 22 }])
    expect(test!.matrixLabels).toEqual(['20', '22'])
  })

  test('keeps every step field a run needs', () => {
    const steps = result.workflow!.jobs[0]!.steps

    expect(steps).toHaveLength(4)
    expect(steps[0]!.uses).toBe('actions/checkout@v4')
    expect(steps[1]!.with).toEqual({ 'bun-version': 'latest' })
    expect(steps[2]!.run).toBe('bun install')
    expect(steps[2]!.env).toEqual({ NODE_ENV: 'test' })
    expect(steps[3]!.id).toBe('test')
  })

  test('and the strategy, including the default that surprises people', () => {
    // Actions defaults `fail-fast` to true: one failed combination cancels the
    // rest. This workflow turns it off, and the parser has to notice.
    expect(result.workflow!.jobs[0]!.failFast).toBe(false)
    expect(result.workflow!.jobs[0]!.maxParallel).toBe(4)
    expect(result.workflow!.jobs[0]!.timeoutMinutes).toBe(20)
  })

  test('reads concurrency rather than accepting and dropping it', () => {
    // The named failure: Gitea takes `concurrency:` and does nothing with it,
    // which is how a workflow that relies on it looks like it works.
    expect(result.workflow!.concurrency).toEqual({ group: 'ci-${{ github.ref }}', cancelInProgress: true })
  })

  test('and the workflow-level env and defaults', () => {
    expect(result.workflow!.env).toEqual({ CI: 'true' })
    expect(result.workflow!.defaults).toEqual({ shell: 'bash', workingDirectory: './app' })
  })
})

describe('runs-on, in every shape Actions accepts', () => {
  test('a label, a list, and the group object', () => {
    // The object form is a named migration blocker: Gitea does not support it,
    // and this parser refused it outright until it was tested.
    expect(runsOnFrom('ubuntu-latest')).toEqual(['ubuntu-latest'])
    expect(runsOnFrom(['self-hosted', 'linux', 'arm64'])).toEqual(['self-hosted', 'linux', 'arm64'])
    expect(runsOnFrom({ group: 'production', labels: ['linux', 'x64'] })).toEqual(['production', 'linux', 'x64'])
    expect(runsOnFrom({ group: 'production' })).toEqual(['production'])
  })

  test('and the object form parses as a whole workflow', async () => {
    const result = parseWorkflow(`
on: push
jobs:
  build:
    runs-on:
      group: production
      labels: [linux, x64]
    steps:
      - run: bun test
`)

    expect(result.errors).toEqual([])
    expect(result.workflow!.jobs[0]!.runsOn).toEqual(['production', 'linux', 'x64'])
  })

  test('and a job with none is refused, with the fix', () => {
    const result = parseWorkflow(`
on: push
jobs:
  build:
    steps:
      - run: echo hi
`)

    expect(result.ok).toBe(false)
    expect(result.errors[0]!.message).toContain('does not say what it runs on')
    expect(result.errors[0]!.fix).toContain('ubuntu-latest')
  })
})

describe('concurrency and defaults on their own', () => {
  test('a bare string is the group, with no cancellation', () => {
    expect(concurrencyFrom('release')).toEqual({ group: 'release', cancelInProgress: false })
    expect(concurrencyFrom({ group: 'ci', 'cancel-in-progress': true })).toEqual({ group: 'ci', cancelInProgress: true })
  })

  test('and anything without a group is nothing', () => {
    expect(concurrencyFrom(undefined)).toBeNull()
    expect(concurrencyFrom({ 'cancel-in-progress': true })).toBeNull()
  })

  test('defaults come from `run`, and are null when absent', () => {
    expect(defaultsFrom({ run: { shell: 'pwsh' } })).toEqual({ shell: 'pwsh', workingDirectory: null })
    expect(defaultsFrom(undefined)).toEqual({ shell: null, workingDirectory: null })
  })
})

describe('a workflow Actions would refuse too', () => {
  test('a step with neither run nor uses', () => {
    const result = parseWorkflow(`
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: does nothing
`)

    expect(result.ok).toBe(false)
    expect(result.errors[0]!.message).toContain('does nothing')
  })

  test('a step with both', () => {
    const result = parseWorkflow(`
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        run: echo hi
`)

    expect(result.errors.some(error => error.message.includes('both'))).toBe(true)
  })

  test('a misspelled key, with the fix that names the convention', () => {
    // `runsOn` rather than `runs-on` is the mistake somebody makes once per
    // language they came from, and "unknown key" with no suggestion is the
    // same as no error at all.
    const result = parseWorkflow(`
on: push
jobs:
  build:
    runsOn: ubuntu-latest
    steps:
      - run: echo hi
`)

    expect(result.errors.some(error => error.fix.includes('hyphenated'))).toBe(true)
  })

  test('and jobs that wait on each other, named rather than counted', () => {
    const result = parseWorkflow(`
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    needs: [b]
    steps: [{ run: echo a }]
  b:
    runs-on: ubuntu-latest
    needs: [a]
    steps: [{ run: echo b }]
`)

    expect(result.ok).toBe(false)
    expect(result.errors.some(error => error.message.includes('a → b') || error.message.includes('b → a'))).toBe(true)
  })
})

describe('a matrix past the ceiling', () => {
  test('is refused with a message that says what to do', () => {
    const axis = Array.from({ length: 20 }, (_, at) => at).join(', ')

    const result = parseWorkflow(`
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        a: [${axis}]
        b: [${axis}]
    steps: [{ run: echo hi }]
`)

    expect(result.ok).toBe(false)
    expect(result.errors[0]!.message).toContain('400 jobs')
  })
})

describe('files that are not workflows', () => {
  test('unparseable YAML is an error with a line, not an exception', () => {
    const result = parseWorkflow('name: [unclosed\n  - broken: :', '.github/workflows/bad.yml')

    expect(result.ok).toBe(false)
    expect(result.errors).not.toEqual([])
  })

  test('and an empty file says what a workflow is', () => {
    const result = parseWorkflow('')

    expect(result.ok).toBe(false)
    expect(result.errors[0]!.fix.length).toBeGreaterThan(0)
  })
})

describe('the helpers the errors lean on', () => {
  test('lineOf points into the file the author has open', () => {
    const source = 'name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n'

    expect(lineOf(source, 'jobs')).toBe(4)
    expect(lineOf(source, 'runs-on')).toBe(6)
    expect(lineOf(source, 'nothing-here')).toBe(0)
  })

  test('and cyclicJobs names the loop rather than reporting one exists', () => {
    const job = (id: string, needs: string[]) => ({ id, needs } as any)

    expect(cyclicJobs([job('a', ['b']), job('b', ['a'])])).toEqual(['a', 'b'])
    expect(cyclicJobs([job('a', []), job('b', ['a'])])).toEqual([])
  })
})
