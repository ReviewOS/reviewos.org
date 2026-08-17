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
import { CONFORMANCE, conformanceCounts, differencesIn } from '../../app/Actions/Workflow/conformance'
import { renderConformance } from '../../app/Docs/conformance'
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

describe('the warnings the parser emits', () => {
  /*
   * The rule the roadmap sets: a deliberate difference is documented *and* the
   * parser says so, rather than quietly doing something else. Both come from
   * the same table, so a difference cannot be documented one way and warned
   * about another - and adding one without writing down its reason is
   * impossible rather than discouraged.
   */
  test('name the keys a workflow uses that behave differently here', async () => {
    const source = await Bun.file(join(CORPUS, 'docker.yml')).text()
    const result = parseWorkflow(source, '.github/workflows/docker.yml')

    const keys = result.warnings.map(warning => warning.key)

    expect(keys).toContain('jobs.<id>.container')
    expect(keys).toContain('jobs.<id>.services')

    // The words are the published table's words, so a person reading the
    // warning and a person reading the page are told the same thing.
    const container = result.warnings.find(warning => warning.key === 'jobs.<id>.container')

    expect(container?.message).toBe(CONFORMANCE.find(entry => entry.key === 'jobs.<id>.container')?.behaviour)
  })

  test('a workflow using only supported keys warns about nothing', () => {
    const result = parseWorkflow(
      'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n',
      '.github/workflows/plain.yml',
    )

    expect(result.warnings).toEqual([])
  })

  /*
   * An ordinary CI workflow, and the two things it is worth telling its author:
   * `permissions` defaults differently here, and `fail-fast` is stored but not
   * yet acted on. Neither stops the workflow running, and both are things
   * somebody would otherwise discover by watching a run behave unexpectedly.
   */
  test('and a real workflow gets exactly the notes it should', async () => {
    const source = await Bun.file(join(CORPUS, 'node-ci.yml')).text()
    const result = parseWorkflow(source, '.github/workflows/node-ci.yml')

    expect(result.warnings.map(warning => warning.key)).toEqual([
      'jobs.<id>.strategy.fail-fast',
      'permissions',
    ])
  })

  test('and a release trigger is named as a deliberate difference', async () => {
    const source = await Bun.file(join(CORPUS, 'release.yml')).text()
    const result = parseWorkflow(source, '.github/workflows/release.yml')

    const release = result.warnings.find(warning => warning.key === 'on.release')

    expect(release?.status).toBe('differs')
    expect(release?.message).toContain('published')
  })

  test('a refused workflow carries no warnings at all', () => {
    /*
     * Its author has errors to fix, and "by the way, `container:` behaves
     * differently here" underneath them is noise on top of a problem. The
     * differences matter once the file is valid enough to run.
     */
    const result = parseWorkflow('jobs:\n  a:\n    container: node\n', '.github/workflows/broken.yml')

    expect(result.ok).toBe(false)
    expect(result.warnings).toEqual([])
  })

  test('the same keys warn in the same order every time', () => {
    // A diff of a run's warnings should show what changed rather than what
    // moved.
    const source = 'on: push\njobs:\n  a:\n    runs-on: x\n    container: node\n    services: {}\n    steps: [{ run: x, shell: bash }]\n'

    expect(differencesIn(Bun.YAML.parse(source)).map(entry => entry.key))
      .toEqual(differencesIn(Bun.YAML.parse(source)).map(entry => entry.key))

    expect(differencesIn(Bun.YAML.parse(source)).map(entry => entry.key))
      .toEqual([...differencesIn(Bun.YAML.parse(source)).map(entry => entry.key)].sort())
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
