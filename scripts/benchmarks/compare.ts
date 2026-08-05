/**
 * The same page, at two commits, measured against each other.
 *
 * A single set of numbers says what something costs. It does not say whether a
 * change made it worse, because the machine it was measured on is never the
 * same twice: another process wakes up, the fans spin down, the profile is
 * cold. The only reliable comparison is one where both sides are measured on
 * the same machine within a minute of each other, alternating, so drift lands
 * on both.
 *
 * This does not build or serve anything. Two dev servers, two databases and two
 * builds is a lot of machinery for a benchmark, and getting it wrong produces
 * confident numbers from a misconfigured server. Instead it takes two URLs that
 * are already running and alternates between them, which is the part that
 * cannot be done by hand.
 *
 * The worktrees are yours to make:
 *
 *   git worktree add /tmp/bench-base <base-sha>
 *   git worktree add /tmp/bench-head <head-sha>
 *   # in each, install and start a dev server on its own port
 *
 * Then:
 *
 *   bun scripts/benchmarks/compare.ts \
 *     --base http://localhost:3000/stacks/stacks/pull/9001/files \
 *     --head http://localhost:3001/stacks/stacks/pull/9001/files \
 *     --runs 3
 */

import { type TraceRun, traceUrl } from './trace'

interface Side {
  label: string
  url: string
  runs: TraceRun[]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10
    : sorted[middle]!
}

/**
 * The noise floor of a browser trace on one machine.
 *
 * Measured by running this against the same URL on both sides, which is the
 * only honest way to find it: the three large metrics drifted 3 to 4 percent
 * between identical runs. Anything under five is the machine.
 */
const NOISE_PERCENT = 5

/**
 * And the floor in absolute terms.
 *
 * A percentage alone is the wrong test for a small metric. `ParseHTML` totals
 * under thirty milliseconds over a four second scroll, so two milliseconds of
 * ordinary drift is six percent of it - and the first version of this called
 * two identical URLs "slower" on exactly that. A change has to clear both
 * bars before it is called one.
 */
const NOISE_MS = 5

/**
 * The change between two medians.
 *
 * Reported with the caveat attached rather than as a bare number, because a
 * browser trace of a four second scroll is noisy and a reader looking at "+3%"
 * with no context will believe it.
 */
function change(before: number, after: number): { deltaMs: number, percent: number, verdict: string } {
  const deltaMs = Math.round((after - before) * 10) / 10
  const percent = before === 0 ? 0 : Math.round((deltaMs / before) * 1000) / 10

  const measurable = Math.abs(percent) >= NOISE_PERCENT && Math.abs(deltaMs) >= NOISE_MS
  const verdict = !measurable
    ? 'no measurable difference'
    : (percent > 0 ? 'slower' : 'faster')

  return { deltaMs, percent, verdict }
}

const args = process.argv.slice(2)
const read = (flag: string) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const baseUrl = read('--base')
const headUrl = read('--head')
const runs = Number(read('--runs') ?? 3)
const headed = args.includes('--headed')

if (!baseUrl || !headUrl) {
  console.error('Usage: bun scripts/benchmarks/compare.ts --base <url> --head <url> [--runs 3] [--headed]')
  process.exit(1)
}

const base: Side = { label: 'base', url: baseUrl, runs: [] }
const head: Side = { label: 'head', url: headUrl, runs: [] }

// Alternating, one run each at a time. Measuring one side to completion and
// then the other lets anything that changes over the minute in between - a
// background job, thermal throttling, a cache filling - land entirely on one
// of them and read as a regression.
for (let round = 0; round < Math.max(1, runs); round++) {
  base.runs.push(...(await traceUrl(base.url, 1, headed)).runs)
  head.runs.push(...(await traceUrl(head.url, 1, headed)).runs)
  console.error(`round ${round + 1} of ${runs} done`)
}

const metrics = ['styleAndLayoutMs', 'paintAndCompositeMs', 'scriptMs', 'parseHtmlMs'] as const

const comparison: Record<string, unknown> = {}
for (const metric of metrics) {
  const beforeValue = median(base.runs.map(run => run[metric]))
  const afterValue = median(head.runs.map(run => run[metric]))
  comparison[metric] = { base: beforeValue, head: afterValue, ...change(beforeValue, afterValue) }
}

const suspect = [...base.runs, ...head.runs].filter(run => run.scroll.stepMismatches > 0).length

console.log(JSON.stringify({
  base: base.url,
  head: head.url,
  runsPerSide: base.runs.length,
  headed,
  // A run whose scroll did not land where it was told measured a different
  // scroll. Any at all and the comparison below is not trustworthy.
  runsWithScrollMismatch: suspect,
  comparison,
}, null, 2))
