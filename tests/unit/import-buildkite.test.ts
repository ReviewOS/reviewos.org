// Buildkite's pipeline.yml, translated.
//
// The report is the deliverable, and these tests are mostly about it: a silent
// partial translation is worse than a refusal, because a workflow with three
// attributes quietly dropped is one somebody trusts, pushes, and then debugs
// from the wrong end.

import { describe, expect, test } from 'bun:test'
import { ATTRIBUTE_MAP, describeTranslation, testExecutionsFrom, translatePipeline } from '../../app/Actions/Import/buildkite'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

const PIPELINE = `steps:
  - label: ":hammer: Build"
    key: build
    command: make dist
    agents:
      queue: linux
    artifact_paths:
      - dist/**
    timeout_in_minutes: 30
  - label: Test
    key: test
    commands:
      - bun install
      - bun test
    parallelism: 4
    soft_fail:
      - exit_status: 2
  - wait: ~
  - block: Deploy to production?
    key: gate
  - label: Deploy
    key: deploy
    command: ./deploy.sh
    depends_on: gate
    concurrency: 1
    concurrency_group: production
    plugins:
      - docker-compose#v4.0.0:
          run: app
`

describe('the translation', () => {
  test('produces a workflow this instance can actually parse', () => {
    const { workflow } = translatePipeline(PIPELINE)
    const parsed = parseWorkflow(workflow, '.reviewos/workflows/imported.yml')

    // The whole point: the output is a file somebody commits, not a sketch.
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
  })

  test('keeps the graph a barrier expresses', () => {
    const { workflow } = translatePipeline(PIPELINE)

    // A `wait` is not a job in Buildkite and is one here; what has to survive
    // is that everything after it happens after it.
    expect(workflow).toContain('wait: true')
    expect(workflow).toContain('block:')
    expect(workflow).toContain('needs:')
  })

  test('and the steps between barriers stay parallel', () => {
    const { workflow } = translatePipeline(PIPELINE)
    const test = workflow.slice(workflow.indexOf('  test:'))

    // Chaining each step to the one before would serialise a pipeline that was
    // not - a translation slower than the original, which reads as this product
    // being slow.
    expect(test.slice(0, test.indexOf('runs-on'))).not.toContain('needs:')
  })

  test('renames what has a name here', () => {
    const { workflow } = translatePipeline(PIPELINE)

    expect(workflow).toContain('timeout-minutes: 30')
    expect(workflow).toContain('artifact-paths:')
    expect(workflow).toContain('concurrency-group:')
    expect(workflow).toContain('parallelism: 4')
    // `agents: { queue: linux }` is a label, which is what `runs-on` takes.
    expect(workflow).toContain('runs-on: linux')
  })
})

describe('the report', () => {
  test('says which attributes changed meaning', () => {
    const { report } = translatePipeline(PIPELINE)
    const test = report.steps.find(one => one.label === 'Test')

    // A list of tolerated exit statuses becomes a boolean, which tolerates
    // every failure rather than the ones named. Somebody has to know that.
    const soft = test!.attributes.find(one => one.from === 'soft_fail')

    expect(soft!.fidelity).toBe('changed')
    expect(soft!.note).toContain('every failure')
  })

  test('and never drops one silently', () => {
    const { report } = translatePipeline(PIPELINE)

    expect(report.losses.some(one => one.includes('plugins'))).toBe(true)

    const lines = describeTranslation(report)

    expect(lines.join('\n')).toContain('plugins has no equivalent')
  })

  test('and names an attribute this instance has never heard of', () => {
    const { report } = translatePipeline('steps:\n  - command: make\n    fancy_new_thing: yes\n')

    expect(report.losses[0]).toContain('fancy_new_thing')
  })

  test('and covers every key the documented table lists', () => {
    // The table is the mapping, and the importer reads it: a mapping that is
    // true in the documentation and different in the code is the failure this
    // arrangement exists to prevent.
    for (const key of ['command', 'depends_on', 'agents', 'parallelism', 'artifact_paths', 'plugins'])
      expect(ATTRIBUTE_MAP[key]).toBeTruthy()
  })
})

describe('the shapes a pipeline comes in', () => {
  test('a bare list of commands', () => {
    const { workflow } = translatePipeline('steps:\n  - "make"\n  - "make test"\n')

    expect(workflow).toContain('run: make')
    expect(workflow).toContain('run: \'make test\'')
  })

  test('and a group, flattened with its name kept', () => {
    const { report } = translatePipeline(`steps:
  - group: Checks
    steps:
      - label: Lint
        command: make lint
`)

    expect(report.steps[0]!.kind).toBe('group')
    expect(report.steps.some(one => one.label === 'Lint')).toBe(true)
  })

  test('and a file that is not a pipeline at all is an empty workflow rather than a throw', () => {
    const { workflow, report } = translatePipeline('this is not yaml: [')

    expect(workflow).toContain('jobs:')
    expect(report.steps).toEqual([])
  })
})

/*
 * The history, which is the part a move cannot recreate: the flaky verdict took
 * months of runs to accumulate, and starting empty starts by forgetting which
 * tests to distrust.
 */
describe('test results carried across', () => {
  test('convert seconds to milliseconds, which is the one silent unit', () => {
    const [execution] = testExecutionsFrom([
      { name: 'signs in', scope: 'auth.test.ts', result: 'passed', duration: 4.2 },
    ])

    // A suite of four-second tests imported as four-millisecond ones looks like
    // a suite that got faster, and nothing about it reads as wrong.
    expect(execution!.durationMs).toBe(4200)
    expect(execution!.scope).toBe('auth.test.ts')
  })

  test('and drop an outcome nobody recorded rather than calling it a pass', () => {
    const executions = testExecutionsFrom([
      { name: 'a', result: 'failed', failure_reason: 'raced' },
      { name: 'b', result: 'unknown' },
      { name: 'c', result: 'skipped' },
      { name: '', result: 'passed' },
    ])

    // Importing `unknown` as a pass is how a green history gets invented.
    expect(executions.map(one => one.name)).toEqual(['a', 'c'])
    expect(executions[0]!.failureMessage).toBe('raced')
  })
})
