// Two ways to write a workflow, one thing that runs.
//
// The rule this file defends is not "the SDK works". It is that **neither front
// door can express something the other cannot represent in the run** - because a
// capability reachable from only one of them becomes a screen that renders
// differently depending on how a workflow was written, which is how two
// products grow inside one.
//
// The structural argument is that the SDK emits YAML and the program form emits
// a document, so both meet the same parser and produce the same rows. That
// argument is only worth as much as the round trip actually surviving, which is
// what this checks: everything the typed surface can say, said, and then read
// back through the parser the server uses.

import { describe, expect, test } from 'bun:test'
import { defineWorkflow, toYaml } from '../../app/Actions/Workflow/sdk'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

/** A workflow using every field the typed surface has. */
function everything(): string {
  return toYaml(defineWorkflow({
    name: 'Everything',
    on: {
      push: { branches: ['main', 'release/*'], tags: ['v*'], paths: ['src/**'] },
      pullRequest: { branches: ['main'], paths: ['src/**'] },
      schedule: ['0 3 * * *'],
      workflowDispatch: {
        inputs: {
          version: { description: 'What to release', required: true, type: 'string' },
          where: { description: 'Which environment', type: 'choice', options: ['staging', 'production'], default: 'staging' },
        },
      },
    },
    env: { CI: 'true' },
    concurrency: { group: 'release-${{ github.ref }}', cancelInProgress: true },
  }, (workflow) => {
    workflow.job('build', {
      name: 'Build it',
      runsOn: ['ubuntu-latest'],
      env: { NODE_ENV: 'test' },
      timeoutMinutes: 30,
      strategy: { matrix: { node: [20, 22] }, failFast: false },
      reviewos: { 'if-changed': 'src/**', 'priority': 10, 'retry': 2 },
      steps: [
        { name: 'Checkout', uses: 'actions/checkout@v4', with: { 'fetch-depth': 0 } },
        { name: 'Build', run: 'make build', env: { LEVEL: 'high' }, workingDirectory: './app', if: "github.ref == 'refs/heads/main'" },
        { name: 'Upload', run: 'make upload', continueOnError: true },
      ],
    })

    workflow.job('gate', {
      needs: ['build'],
      reviewos: { block: 'Ship it?' },
      steps: [],
    })

    workflow.job('deploy', {
      needs: ['gate'],
      runsOn: 'ubuntu-latest',
      environment: 'production',
      if: 'success()',
      steps: [{ run: 'make deploy' }],
    })
  }))
}

describe('what the typed surface emits', () => {
  const yaml = everything()
  const parsed = parseWorkflow(yaml, '.reviewos/workflows/everything.ts')

  test('is read by the parser the server reads with, without complaint', () => {
    /*
     * The whole argument in one assertion. If the SDK could emit something the
     * parser refuses, the second front door would be a way to write workflows
     * that do not run - and the failure would arrive on a push rather than
     * where the program was written.
     */
    expect(parsed.errors.map(one => one.message)).toEqual([])
    expect(parsed.ok).toBe(true)
  })

  test('and every job survives with the shape it was given', () => {
    const jobs = parsed.workflow!.jobs
    const build = jobs.find(job => job.id === 'build')!
    const gate = jobs.find(job => job.id === 'gate')!
    const deploy = jobs.find(job => job.id === 'deploy')!

    expect(build.steps.length).toBe(3)
    expect(build.timeoutMinutes).toBe(30)
    expect(build.ifChanged).toEqual(['src/**'])
    expect(build.priority).toBe(10)

    // A `reviewos:` extension travels through the typed surface as itself, so a
    // kind decided in a program is the same kind decided in YAML.
    expect(gate.kind).toBe('block')

    expect(deploy.needs).toEqual(['gate'])
    expect(String(deploy.environment ?? '')).toBe('production')
  })

  test('and the triggers are the ones that were declared', () => {
    const triggers = (parsed.workflow as any).triggers

    expect(triggers.push.branches).toEqual(['main', 'release/*'])
    expect(triggers.push.tags).toEqual(['v*'])
    expect(triggers.push.paths).toEqual(['src/**'])
    expect(triggers.pullRequest.branches).toEqual(['main'])
    expect(triggers.dispatch).toBe(true)
    expect(triggers.schedule).toEqual(['0 3 * * *'])
  })

  test('and a dispatch input keeps what a caller will be checked against', () => {
    /*
     * The inputs are the one part of a trigger that is *validated* later, so a
     * choice that lost its options in translation would become a dispatch that
     * accepts anything - the failure being a run started with a value the
     * workflow was written to refuse.
     */
    const inputs = (parsed.workflow as any).triggers.dispatchInputs ?? []
    const where = inputs.find((one: any) => one.name === 'where')

    expect(where).toBeTruthy()
    expect(where.type).toBe('choice')
    expect(where.options).toEqual(['staging', 'production'])
    expect(where.default).toBe('staging')
  })
})

describe('the matrix, which is the case where the two doors could diverge', () => {
  test('expands the same way whichever door wrote it', () => {
    /*
     * A matrix is expanded by the dispatcher from the parsed document, not by
     * whoever wrote it. So the property is that the typed form produces the
     * same *document* a person would write by hand - the expansion after that
     * is one code path with nothing to disagree with.
     */
    const typed = parseWorkflow(everything(), 'x.ts').workflow!.jobs.find(job => job.id === 'build')!

    const written = parseWorkflow(`name: X
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]
    steps:
      - run: make build
`, 'x.yml').workflow!.jobs[0]!

    expect(typed.matrix).toEqual(written.matrix)
    expect(typed.failFast).toBe(written.failFast)
  })
})
