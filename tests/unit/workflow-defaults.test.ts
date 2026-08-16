// `defaults:` - the shell and directory a step runs in when it does not say.
//
// Same three levels as `env` and the same precedence, with one difference worth
// a suite of its own: "nothing" here means the runner decides, which is a real
// answer rather than a gap. Baking `bash` on this side would invent a default
// the file never asked for, and make it impossible to tell from one it did.

import { describe, expect, test } from 'bun:test'
import { defaultsOf, resolveDefaults } from '../../app/Actions/Workflow/defaults'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

describe('resolving what a step runs with', () => {
  test('the step wins, then the job, then the workflow', () => {
    const resolved = resolveDefaults({
      workflow: { shell: 'bash', workingDirectory: '/w' },
      job: { shell: 'sh', workingDirectory: '/j' },
      step: { shell: 'pwsh', workingDirectory: '/s' },
    })

    expect(resolved).toMatchObject({ shell: 'pwsh', workingDirectory: '/s', shellFrom: 'step' })
  })

  test('and each key falls through on its own', () => {
    // A step that sets only `working-directory` still inherits the shell.
    const resolved = resolveDefaults({
      workflow: { shell: 'bash' },
      job: { workingDirectory: '/j' },
      step: { workingDirectory: '/s' },
    })

    expect(resolved).toMatchObject({
      shell: 'bash',
      shellFrom: 'workflow',
      workingDirectory: '/s',
      workingDirectoryFrom: 'step',
    })
  })

  /*
   * The difference from `env`. There is no sensible instance-wide default:
   * the answer depends on the platform the runner is on, which is knowledge
   * this side does not have.
   */
  test('nothing anywhere is the runner\'s choice, named as such', () => {
    const resolved = resolveDefaults({})

    expect(resolved.shell).toBeNull()
    expect(resolved.shellFrom).toBe('runner')
  })

  test('an empty string is a mistake rather than an answer', () => {
    // `shell: ''` would otherwise hand the runner an empty command name
    // instead of falling through to the level that meant something.
    const resolved = resolveDefaults({ workflow: { shell: 'bash' }, step: { shell: '   ' } })

    expect(resolved).toMatchObject({ shell: 'bash', shellFrom: 'workflow' })
  })

  test('reads the pair off a stored row', () => {
    expect(defaultsOf({ default_shell: 'bash', default_working_directory: '/app' }))
      .toEqual({ shell: 'bash', workingDirectory: '/app' })

    expect(defaultsOf(null)).toEqual({ shell: null, workingDirectory: null })
  })
})

describe('what the parser reads', () => {
  const workflow = `name: CI
on: push
defaults:
  run:
    shell: bash
    working-directory: ./app
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: sh
    steps:
      - run: make
        working-directory: ./tools
        continue-on-error: true
      - run: make check
        shell: pwsh
`

  test('defaults at both levels, and the step keys that go with them', () => {
    const result = parseWorkflow(workflow, '.github/workflows/ci.yml')

    expect(result.ok).toBe(true)

    const job = result.workflow!.jobs[0]!

    expect(result.workflow!.defaults).toEqual({ shell: 'bash', workingDirectory: './app' })
    expect(job.defaults).toEqual({ shell: 'sh', workingDirectory: null })
    expect(job.steps[0]).toMatchObject({ workingDirectory: './tools', continueOnError: true, shell: null })
    expect(job.steps[1]).toMatchObject({ shell: 'pwsh', continueOnError: false })
  })

  test('and the three levels then resolve the way the file reads', () => {
    const result = parseWorkflow(workflow, '.github/workflows/ci.yml')
    const job = result.workflow!.jobs[0]!

    // First step: no shell of its own, so the job's `sh`; its own directory.
    expect(resolveDefaults({
      workflow: result.workflow!.defaults,
      job: job.defaults,
      step: { shell: job.steps[0]!.shell, workingDirectory: job.steps[0]!.workingDirectory },
    })).toMatchObject({ shell: 'sh', shellFrom: 'job', workingDirectory: './tools' })

    // Second step: its own shell, and the workflow's directory since neither it
    // nor the job named one.
    expect(resolveDefaults({
      workflow: result.workflow!.defaults,
      job: job.defaults,
      step: { shell: job.steps[1]!.shell, workingDirectory: job.steps[1]!.workingDirectory },
    })).toMatchObject({ shell: 'pwsh', workingDirectory: './app', workingDirectoryFrom: 'workflow' })
  })

  /*
   * Only a literal `true`. An expression - `${{ inputs.soft }}` - needs the
   * expression engine, and reading it as truthy text would make every such step
   * unfailable, which is the dangerous direction.
   */
  test('continue-on-error as an expression is not read as true', () => {
    const result = parseWorkflow(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: make
        continue-on-error: \${{ inputs.soft }}
`, '.github/workflows/a.yml')

    expect(result.workflow!.jobs[0]!.steps[0]!.continueOnError).toBe(false)
  })
})
