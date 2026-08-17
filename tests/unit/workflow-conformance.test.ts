// The conformance suite: real workflows, parsed, with the result published.
//
// The roadmap's own standard and the reason it exists: *silence about a gap is
// how Gitea's ignored `concurrency:` surprised people*. A forge that accepts a
// key and does nothing with it has not implemented it - it has hidden the fact
// that it has not.
//
// So this does two things. It runs the parser over a corpus of workflows in the
// shapes people actually write, and it keeps the published table honest about
// what every key does.

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFORMANCE, conformanceCounts, renderConformance } from '../../app/Docs/conformance'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

const CORPUS = 'tests/fixtures/conformance'

function corpusFiles(): string[] {
  return readdirSync(CORPUS).filter(name => name.endsWith('.yml')).sort()
}

describe('the corpus', () => {
  test('is not empty, and is what the report is about', () => {
    // A conformance suite with no corpus is a claim rather than a test.
    expect(corpusFiles().length).toBeGreaterThanOrEqual(6)
  })

  test('every workflow in it parses without errors', async () => {
    const problems: Array<{ file: string, errors: unknown[] }> = []

    for (const file of corpusFiles()) {
      const source = await Bun.file(join(CORPUS, file)).text()
      const result = parseWorkflow(source, `.github/workflows/${file}`)

      if (!result.ok || result.errors.length > 0)
        problems.push({ file, errors: result.errors })
    }

    /*
     * Reported with the file and the errors rather than as a count. A failure
     * here means a real workflow this instance would refuse, and the whole
     * value is knowing which one and why without running anything by hand.
     */
    expect(problems).toEqual([])
  })

  test('and the constructs they use are the ones the report describes', async () => {
    // A corpus that exercises nothing the table mentions would pass forever
    // while proving nothing.
    const sources = await Promise.all(corpusFiles().map(file => Bun.file(join(CORPUS, file)).text()))
    const all = sources.join('\n')

    for (const marker of ['strategy:', 'concurrency:', 'permissions:', 'workflow_call:', 'container:', 'services:', 'schedule:', 'issues:'])
      expect(all).toContain(marker)
  })

  test('a workflow using a container is parsed rather than refused', async () => {
    /*
     * The distinction the report exists to make. `container:` is not
     * implemented - the runner refuses it - and that is not the same as the
     * file being invalid. Refusing to parse it would mean a repository could
     * not even register the workflow it already has.
     */
    const source = await Bun.file(join(CORPUS, 'docker.yml')).text()
    const result = parseWorkflow(source, '.github/workflows/docker.yml')

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('the published table', () => {
  test('covers every key with a status and a sentence', () => {
    for (const entry of CONFORMANCE) {
      expect(entry.key.length).toBeGreaterThan(0)
      // The sentence is the point of the table: a status with no explanation is
      // a row nobody can act on.
      expect(entry.behaviour.length).toBeGreaterThan(20)
      expect(entry.behaviour.trim().endsWith('.')).toBe(true)
    }
  })

  test('names no key twice', () => {
    const keys = CONFORMANCE.map(entry => `${entry.level}:${entry.key}`)

    expect(new Set(keys).size).toBe(keys.length)
  })

  /*
   * The rule the roadmap asks for: where behaviour deliberately differs from
   * Actions, the reason is written down. A `differs` row with no reason is the
   * quiet divergence this whole page exists to prevent.
   */
  test('every deliberate difference says why', () => {
    /*
     * Two sentences at least: what it does, and why it is not what Actions
     * does. Checked structurally rather than by sniffing for words like
     * "because" - a vocabulary test passes a row that says "rather than"
     * meaninglessly and fails one that explains itself in plain language, which
     * is exactly what the first version of this test did.
     */
    for (const entry of CONFORMANCE.filter(row => row.status === 'differs' || row.status === 'refused')) {
      const sentences = entry.behaviour.split(/(?<=[.;])\s+/).filter(part => part.trim().length > 0)

      expect(sentences.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('and the counts add up', () => {
    const counts = conformanceCounts()
    const total = counts.supported + counts.differs + counts.unimplemented + counts.refused

    expect(total).toBe(CONFORMANCE.length)
    // A table that is all green is a table nobody checked.
    expect(counts.unimplemented).toBeGreaterThan(0)
    expect(counts.differs).toBeGreaterThan(0)
  })

  test('renders a page with every key on it', () => {
    const page = renderConformance('from the conformance table')

    for (const entry of CONFORMANCE)
      expect(page).toContain(entry.key)

    expect(page).toContain('silence about a gap')
  })
})

describe('the committed page', () => {
  test('is what the generator produces today', async () => {
    /*
     * The drift check, the same one the API reference has. A table that is
     * generated but committed stale is worse than one nobody generated: it
     * reads as current.
     */
    const committed = await Bun.file('docs/conformance.md').text()

    expect(committed).toBe(renderConformance(committedStamp(committed)))
  })
})

/** The stamp the committed page carries, so the comparison is about content. */
function committedStamp(page: string): string {
  const match = /^Generated (.+)\.$/m.exec(page)

  return match ? String(match[1]) : ''
}
