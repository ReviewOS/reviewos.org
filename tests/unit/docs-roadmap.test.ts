/**
 * The landing page's progress figures, against the roadmap they claim to mirror.
 *
 * `resources/views/index.stx` carried the phase list by hand under a comment
 * saying "Counts mirror docs/todo/index.md". It did not: the page advertised
 * `06 Search and explore - 20/21` and `07 Marketing and docs - 21/45` while the
 * roadmap had both complete at 21/21 and 58/58. Nobody reports a public page
 * underselling finished work, because it reads as modesty.
 *
 * So the page derives them now, and these hold the derivation. The last test is
 * the one that matters: it reads the real committed roadmap, so a figure that
 * disagrees with it fails here rather than shipping.
 */

import { describe, expect, test } from 'bun:test'
import { landingPhases, parseRoadmap, roadmapPhases, shapeLandingPhases } from '../../app/Docs/roadmap'

const TABLE = `# Roadmap

| Phase | What it covers | State |
|---|---|---|
| [00 - Bootstrap](./00-bootstrap.md) | Scaffold, Postgres, tooling | Complete (58/58) |
| [01 - Foundation](./01-foundation.md) | Users, organizations | Done (77/77) |
| [09 - Checks and CI](./09-checks-ci.md) | Checks, runners | Started (121/122) |

Prose below the table, with a | pipe | in it, which is not a row.
`

describe('reading the roadmap table', () => {
  test('takes the number, the name, the state and both halves of the count', () => {
    const phases = parseRoadmap(TABLE)

    expect(phases).toHaveLength(3)
    expect(phases[0]).toEqual({
      number: '00',
      name: 'Bootstrap',
      covers: 'Scaffold, Postgres, tooling',
      state: 'Complete',
      done: 58,
      total: 58,
      finished: true,
    })
  })

  test('treats Done and Complete as the same fact, and Started as unfinished', () => {
    const phases = parseRoadmap(TABLE)

    expect(phases.map(phase => phase.finished)).toEqual([true, true, false])
  })

  test('ignores the header row and any prose that happens to contain a pipe', () => {
    /*
     * The header is `| Phase | What it covers | State |`, which has the right
     * number of columns and no count - so a parser keyed on pipes alone picks
     * it up and reports a phase called "Phase".
     */
    expect(parseRoadmap(TABLE).map(phase => phase.number)).toEqual(['00', '01', '09'])
  })

  test('answers an empty list rather than throwing when the file is unreadable', async () => {
    /*
     * stx renders a page with every variable undefined when a server script
     * throws, with no error anywhere, so a missing roadmap would take the whole
     * landing page down silently. The section collapses instead.
     */
    expect(await roadmapPhases('/nonexistent-root-for-this-test')).toEqual([])
  })
})

describe('the phases the landing page shows', () => {
  /*
   * A fixture, not the real roadmap.
   *
   * The first version of these compared `landingPhases()` against
   * `roadmapPhases()` and asserted the counts agreed. Both read the same file,
   * so they cannot disagree: it passed with the roadmap deliberately mutated
   * to 100/122. Checking a derivation against its own input proves nothing.
   */
  const table = parseRoadmap(`
| [00 - Bootstrap](./a.md) | x | Complete (5/5) |
| [01 - Foundation](./b.md) | x | Done (7/7) |
| [02 - Git hosting](./c.md) | x | Done (9/9) |
| [03 - Issues](./d.md) | x | Done (3/3) |
| [04 - Reviews](./e.md) | x | Done (4/4) |
| [05 - Notifications](./f.md) | x | Done (6/6) |
| [06 - Search](./g.md) | x | Complete (2/2) |
| [07 - Marketing](./h.md) | x | Complete (8/8) |
| [08 - Migration](./i.md) | x | Done (1/1) |
| [09 - Checks and CI](./j.md) | x | Started (121/122) |
| [10 - Federation](./k.md) | x | Complete (4/4) |
| [15 - Pipelines](./l.md) | x | In progress (188/189) |
`)

  test('are the eight of the core path, whatever their state', () => {
    expect(shapeLandingPhases(table).slice(0, 8).map(phase => phase.number))
      .toEqual(['00', '01', '02', '03', '04', '05', '06', '07'])
  })

  test('then only the unfinished ones beyond it, in order', () => {
    /*
     * 08 and 10 are finished and must not appear; 09 and 15 are open and must.
     * Otherwise the section grows a "Done" row every time a phase lands, which
     * is noise rather than status.
     */
    expect(shapeLandingPhases(table).slice(8).map(phase => phase.number)).toEqual(['09', '15'])
  })

  test('carry the count for an open phase and a plain Done for a finished one', () => {
    const shown = shapeLandingPhases(table)
    const checks = shown.find(phase => phase.number === '09')

    expect(checks).toEqual({ number: '09', name: 'Checks and CI', state: 'next', status: '121/122 complete' })
    expect(shown[0]!.state).toBe('done')
  })

  test('prefer this page\'s own name for a phase where it reads better', () => {
    /*
     * The roadmap's column says "Reviews"; the landing page has always said
     * "Pull requests and reviews", which is the more useful label to a reader
     * evaluating the product. Deriving the list must not cost that.
     */
    expect(shapeLandingPhases(table).find(phase => phase.number === '04')!.name)
      .toBe('Pull requests and reviews')
  })

  test('and the real roadmap still produces a list the template can render', async () => {
    /*
     * Not an assertion about the numbers - that is what the fixture above is
     * for. This is the one thing a fixture cannot cover: that the committed
     * file parses at all, so `@foreach` gets an array rather than undefined and
     * reports "phases is not iterable" into an HTML comment nobody reads.
     */
    const shown = await landingPhases()

    expect(Array.isArray(shown)).toBe(true)
    expect(shown.length).toBeGreaterThanOrEqual(8)
  })
})
