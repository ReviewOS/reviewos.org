/**
 * The roadmap, read rather than restated.
 *
 * `docs/todo/index.md` carries a table of every phase and its count, and that
 * table is the source of truth: AGENTS.md says a box is ticked in the same
 * commit as the work, so the counts move when the work lands.
 *
 * The landing page used to mirror those counts by hand, under a comment saying
 * "Counts mirror docs/todo/index.md". It had drifted: the page advertised
 * `06 Search and explore - 20/21` and `07 Marketing and docs - 21/45` while the
 * roadmap said both were complete, at 21/21 and 58/58. So the public page
 * undersold finished work, which is the one direction of drift nobody reports
 * as a bug.
 *
 * This is the same move `app/Docs/configuration.ts` makes for `.env.example`,
 * and the same one `tests/unit/docs-configuration.test.ts` now makes for the
 * Typesense port: when two places have to agree and nothing derives one from
 * the other, derive one from the other.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RoadmapPhase {
  /** Zero-padded, as the roadmap writes it: `00`, `07`, `17`. */
  number: string
  name: string
  /** The "what it covers" column. */
  covers: string
  /** The word the roadmap uses: `Done`, `Complete`, `In progress`, `Started`. */
  state: string
  done: number
  total: number
  /** Every box ticked. `Done` and `Complete` are the same fact, spelled twice. */
  finished: boolean
}

/*
 * One row of the table, which looks like:
 *
 *   | [06 - Search and explore](./06-search-explore.md) | Indexing, search | Complete (21/21) |
 *
 * Tolerant about the state word because the roadmap uses four of them and
 * treats `Done` and `Complete` as synonyms, and strict about the count, which
 * is the part being read.
 */
const ROW = /^\|\s*\[(\d+)\s*-\s*([^\]]+?)\]\([^)]*\)\s*\|\s*([^|]*?)\s*\|\s*([A-Za-z][A-Za-z ]*?)\s*\((\d+)\/(\d+)\)\s*\|/gm

export function parseRoadmap(markdown: string): RoadmapPhase[] {
  const phases: RoadmapPhase[] = []

  for (const [, number, name, covers, state, done, total] of String(markdown ?? '').matchAll(ROW)) {
    phases.push({
      number: number!,
      name: name!.trim(),
      covers: covers!.trim(),
      state: state!.trim(),
      done: Number(done),
      total: Number(total),
      finished: Number(done) === Number(total) && Number(total) > 0,
    })
  }

  return phases
}

/**
 * The phases, from the committed roadmap.
 *
 * Read at render rather than baked in, because the page server is restarted by
 * every deploy and the file ships with it. A page that would have to be
 * regenerated to tell the truth is the arrangement this replaces.
 */
export async function roadmapPhases(root: string = process.cwd()): Promise<RoadmapPhase[]> {
  try {
    return parseRoadmap(await readFile(join(root, 'docs/todo/index.md'), 'utf-8'))
  }
  catch {
    /*
     * An empty list rather than a throw. stx renders a page with every variable
     * undefined when a server script throws - no error, no stack trace - so a
     * missing roadmap would take the whole landing page down silently. The
     * section built from this collapses to nothing instead, which is visible
     * and survivable.
     */
    return []
  }
}

/** One row as the landing page's phase list renders it. */
export interface LandingPhase {
  number: string
  name: string
  /** What the template switches on for its pill. */
  state: 'done' | 'next'
  status: string
}

/** How many phases are the core path rather than the work beyond it. */
const CORE_PHASES = 8

/** Where the landing page names a phase better than the roadmap's column does. */
const PHASE_LABELS: Record<string, string> = { '04': 'Pull requests and reviews' }

/**
 * The phases the landing page shows, already in its shape.
 *
 * The shaping lives here rather than in the view, and that is not tidiness.
 * stx's `<script server>` did not carry a multi-line derived expression
 * (`[...a, ...b].map(...)`) through to the template: the value simply was not
 * there, and `@foreach` reported "phases is not iterable" into an HTML
 * comment - the failure AGENTS.md warns about, which nobody reads. A single
 * awaited call does arrive, which is the shape `featured()` already uses in
 * that same file, so this function is that shape.
 *
 * The core path is always shown, because it is what the page's argument rests
 * on. Anything after it appears only while unfinished, so the section cannot
 * claim the work is done while a phase is open, and does not list eleven
 * finished phases to say so either.
 */
export async function landingPhases(root?: string): Promise<LandingPhase[]> {
  return shapeLandingPhases(await roadmapPhases(root))
}

/**
 * The selection and the shaping, separated from the reading.
 *
 * Split out so it can be exercised against a known table. The first version of
 * its test compared `landingPhases()` with `roadmapPhases()` and asserted the
 * counts matched - which they cannot fail to, since both read the same file. It
 * passed with the roadmap deliberately mutated, which is the definition of a
 * test that cannot fail. A fixture is the only way to check this.
 */
export function shapeLandingPhases(roadmap: readonly RoadmapPhase[]): LandingPhase[] {
  const core = roadmap.slice(0, CORE_PHASES)
  const open = roadmap.slice(CORE_PHASES).filter(phase => !phase.finished)

  return core.concat(open).map(phase => ({
    number: phase.number,
    name: PHASE_LABELS[phase.number] ?? phase.name,
    state: phase.finished ? 'done' : 'next',
    status: `${phase.done}/${phase.total} complete`,
  }))
}
