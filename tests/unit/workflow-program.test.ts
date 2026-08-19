// A workflow written as a program, read by a control plane that must never run
// it.
//
// The claim under test is the architectural one: everything the instance needs
// to know before dispatch comes out of a text block, and the program below it
// is never parsed, imported, or evaluated on this side of the boundary.

import { describe, expect, test } from 'bun:test'
import { frontMatterOf, isOrchestratorJob, isProgramPath, ORCHESTRATE_ACTION, programDocument } from '../../app/Actions/Workflow/program'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

const program = `/* --- reviewos
name: Release
on:
  push:
    branches: [main]
--- */

import { publish } from '../../src/publish'

export default async function (workflow) {
  for (const pkg of await workflow.step('list', () => packages()))
    await workflow.step(\`publish \${pkg}\`, () => publish(pkg))
}
`

describe('which files are programs', () => {
  test('the TypeScript and JavaScript forms people actually write', () => {
    for (const path of ['a/release.ts', 'a/release.mts', 'a/release.cts', 'a/release.js', 'a/release.mjs'])
      expect(isProgramPath(path)).toBe(true)
  })

  test('and not the documents', () => {
    for (const path of ['a/ci.yml', 'a/ci.yaml', 'a/README.md', 'a/typescript'])
      expect(isProgramPath(path)).toBe(false)
  })
})

describe('the front matter', () => {
  test('is read as text, out of the top of the file', () => {
    expect(frontMatterOf(program)).toContain('name: Release')
    expect(frontMatterOf(program)).toContain('branches: [main]')
  })

  /**
   * The rule that keeps this from becoming evaluation by another name. A block
   * found anywhere is a block that could be *generated* anywhere, and reading
   * configuration out of the middle of a program is one step from running the
   * program to find it.
   */
  test('is not read from the middle of a program', () => {
    const sneaky = `export const x = 1\n\n/* --- reviewos\nname: Sneaky\non: push\n--- */\n`

    expect(frontMatterOf(sneaky)).toBeNull()
  })

  test('and a file that has none says what is missing rather than failing silently', () => {
    const result = programDocument('export default async function () {}\n', '.reviewos/workflows/release.ts')

    expect(result.ok).toBe(false)
    expect((result as any).error).toContain('front matter')
  })
})

describe('the document a program becomes', () => {
  test('parses as an ordinary workflow, with the triggers the author wrote', () => {
    const translated = programDocument(program, '.reviewos/workflows/release.ts')

    expect(translated.ok).toBe(true)

    const parsed = parseWorkflow((translated as any).document, '.reviewos/workflows/release.ts')

    expect(parsed.ok).toBe(true)
    expect(parsed.workflow?.name).toBe('Release')
    // The whole point of the front matter: this is knowable before anything
    // runs, which is what lets the instance decide whether this push starts it.
    expect(parsed.workflow?.triggers.push?.branches).toEqual(['main'])
  })

  /**
   * One job, because the graph is not known before dispatch - that is the
   * entire reason somebody writes a workflow as a program. The jobs it decides
   * on arrive later as journaled calls.
   */
  test('has exactly one job, which runs the program', () => {
    const translated = programDocument(program, '.reviewos/workflows/release.ts')
    const parsed = parseWorkflow((translated as any).document, '.reviewos/workflows/release.ts')

    expect(parsed.workflow?.jobs).toHaveLength(1)
    expect(parsed.workflow?.jobs[0]?.id).toBe('orchestrate')

    const steps = parsed.workflow?.jobs[0]?.steps ?? []

    expect(steps).toHaveLength(1)
    expect(steps[0]?.uses).toBe(ORCHESTRATE_ACTION)
    // Told which file to run, so the runner does not have to guess from the
    // workflow's name.
    expect(steps[0]?.with?.workflow).toBe('.reviewos/workflows/release.ts')
  })

  test('and a program that also writes a static graph is refused', () => {
    // Two answers to "what does this run" and no rule for which wins.
    const both = `/* --- reviewos\nname: Both\non: push\njobs:\n  build:\n    steps: []\n--- */\nexport default async function () {}\n`

    const result = programDocument(both, '.reviewos/workflows/both.ts')

    expect(result.ok).toBe(false)
    expect((result as any).error).toContain('jobs')
  })

  test('and the program body never reaches the parser', () => {
    const translated = programDocument(program, '.reviewos/workflows/release.ts')

    // Not an aesthetic point. Everything below the block is bytes on their way
    // to a machine, exactly like a `run:` script, and the document stored here
    // is the proof that nothing else read them.
    expect((translated as any).document).not.toContain('import { publish }')
    expect((translated as any).document).not.toContain('packages()')
  })
})

describe('which job is the orchestrator', () => {
  /**
   * Derived from the version's path rather than stored a second time: a
   * workflow either lives in a `.ts` file or it does not, and a flag that could
   * disagree with the file it came from is one that eventually will.
   */
  test('the one named orchestrate, on a version that came from a program', () => {
    expect(isOrchestratorJob('orchestrate', '.reviewos/workflows/release.ts')).toBe(true)
  })

  test('and not a job somebody happened to call orchestrate in YAML', () => {
    expect(isOrchestratorJob('orchestrate', '.github/workflows/ci.yml')).toBe(false)
    expect(isOrchestratorJob('build', '.reviewos/workflows/release.ts')).toBe(false)
    expect(isOrchestratorJob('orchestrate', null)).toBe(false)
  })
})
