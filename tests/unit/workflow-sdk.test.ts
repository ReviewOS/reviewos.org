// Workflows as code: the second front door, not a second product.
//
// The property that makes it a front door is that it emits the same document
// the YAML path reads - so the parser, the conformance table and every refusal
// are shared, and an SDK workflow cannot quietly express something a YAML one
// may not. Every test here is about that, or about the one failure a program
// has that YAML does not: a graph that is not the same twice.

import { describe, expect, test } from 'bun:test'
import { checkDeterminism } from '../../app/Actions/Workflow/determinism'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'
import { defineWorkflow, toYaml } from '../../app/Actions/Workflow/sdk'

describe('a workflow written as a program', () => {
  test('produces a document this instance registers, and the same rows as the YAML would', () => {
    const built = toYaml(defineWorkflow(
      { name: 'CI', on: { push: { branches: ['main'] } } },
      (workflow) => {
        workflow.job('test', {
          runsOn: 'ubuntu-latest',
          steps: [{ uses: 'actions/checkout@v4' }, { name: 'Test', run: 'bun test' }],
        })
      },
    ))

    const fromProgram = parseWorkflow(built, 'ci.yml')
    const fromYaml = parseWorkflow([
      'name: CI',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Test',
      '        run: bun test',
    ].join('\n'), 'ci.yml')

    expect(fromProgram.errors).toEqual([])
    // The whole claim of the box: the same normalized workflow, whichever door
    // it came through.
    expect(fromProgram.workflow).toEqual(fromYaml.workflow)
  })

  test('and ordinary control flow expresses the graph', () => {
    const packages = ['api', 'web', 'cli']

    const workflow = defineWorkflow(
      { name: 'Monorepo', on: { push: {} } },
      (builder) => {
        for (const name of packages) {
          builder.job(`test-${name}`, {
            reviewos: { 'if-changed': `packages/${name}/**` },
            steps: [{ run: `bun test packages/${name}` }],
          })
        }

        // The thing YAML cannot say: "everything above", without a list
        // somebody keeps in step.
        builder.job('release', { needs: builder.ids(), steps: [{ run: './release.sh' }] })
      },
    )

    const parsed = parseWorkflow(toYaml(workflow), 'monorepo.yml')

    expect(parsed.errors).toEqual([])
    expect(Object.keys(workflow.jobs)).toHaveLength(4)
    expect(workflow.jobs.release!.needs).toEqual(['test-api', 'test-web', 'test-cli'])
  })

  test('and a duplicated job id is refused rather than silently merged', () => {
    // In YAML the second key wins. In a loop it is usually a template that
    // forgot to vary, and finding that out at build time is the difference
    // between one wrong job and twelve.
    expect(() => defineWorkflow({ name: 'X', on: { push: {} } }, (workflow) => {
      workflow.job('test', { steps: [{ run: 'a' }] })
      workflow.job('test', { steps: [{ run: 'b' }] })
    })).toThrow('already a job')
  })

  test('and the extension keys are typed rather than spelled into a string', () => {
    const yaml = toYaml(defineWorkflow({ name: 'X', on: { push: {} } }, (workflow) => {
      // A gate runs no commands, which the parser enforces - so the SDK cannot
      // express one that does either, because it emits what the parser reads.
      workflow.job('gate', { reviewos: { block: 'Ship it?' }, steps: [] })
      workflow.job('deploy', {
        needs: ['gate'],
        environment: 'production',
        reviewos: { 'artifact-paths': ['dist/**'] },
        steps: [{ run: './deploy.sh' }],
      })
    }))

    const parsed = parseWorkflow(yaml, 'x.yml')

    expect(parsed.errors).toEqual([])
    expect(yaml).toContain('block:')
    expect(yaml).toContain('artifact-paths:')
  })

  test('and an expression survives being written out', () => {
    // `${{ }}` starts with a brace, which YAML reads as a mapping unless it is
    // quoted - the one escaping bug that would make every generated workflow
    // subtly wrong.
    const yaml = toYaml(defineWorkflow(
      { name: 'X', on: { push: {} }, concurrency: { group: 'ci-${{ github.ref }}', cancelInProgress: true } },
      (workflow) => {
        workflow.job('test', { if: '${{ github.event_name == \'push\' }}', steps: [{ run: 'make' }] })
      },
    ))

    const parsed = parseWorkflow(yaml, 'x.yml')

    expect(parsed.errors).toEqual([])
    expect(yaml).toContain('\'ci-${{ github.ref }}\'')
  })
})

describe('what a workflow program may not read', () => {
  test('a clock, because two builds of one commit would differ', () => {
    const problems = checkDeterminism('const stamp = Date.now()\n')

    expect(problems).toHaveLength(1)
    expect(problems[0]!.line).toBe(1)
    expect(problems[0]!.reason).toContain('clock read')
  })

  test('randomness, the environment, the network, and the filesystem', () => {
    const found = checkDeterminism([
      'const a = Math.random()',
      'const b = process.env.HOME',
      'const c = await fetch("https://example.test")',
      'const d = readdirSync("packages")',
    ].join('\n'))

    expect(found.map(one => one.line)).toEqual([1, 2, 3, 4])
  })

  test('but not the same words inside a comment or a string', () => {
    // A rule that fired on an explanation of why not to use `Date.now()` is a
    // rule people work around by deleting the explanation.
    const source = [
      '// Never call Date.now() here: the document would carry the build time.',
      'const note = "Math.random() is forbidden"',
      'const real = 1',
    ].join('\n')

    expect(checkDeterminism(source)).toEqual([])
  })

  test('and a clean program has nothing to say about it', () => {
    expect(checkDeterminism('export default defineWorkflow({ name: "CI" }, w => w.job("a", { steps: [] }))')).toEqual([])
  })
})
