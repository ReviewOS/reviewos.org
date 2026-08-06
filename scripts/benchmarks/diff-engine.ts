/**
 * What the diff engine costs, measured rather than felt.
 *
 * Every number in the phase 14 roadmap came from a script like this one, and a
 * claim with no way to re-check it is a claim that quietly stops being true.
 * This is that way.
 *
 * Server-side only, deliberately. It measures the half that runs before any
 * browser is involved - git, the splitter, the parser, the highlighter, the row
 * renderer - because that half is where a regression is cheap to find and
 * because it needs no browser to run in CI. The scroll and paint half needs
 * Chrome traces and is the next thing to build.
 *
 * Usage:
 *   bun scripts/benchmarks/diff-engine.ts <repo.git> <base> <head> [--rows] [--runs 3]
 */

import { streamMergeBaseDiff } from '../../app/Actions/Git/diffStream'
import { manifestToNdjson, streamManifest } from '../../app/Actions/Pull/manifest'
import { poolStats } from '../../app/Actions/Browse/highlightPool'

interface Run {
  firstRecordMs: number
  totalMs: number
  files: number
  rowRecords: number
  truncatedFrom: number | null
  ndjsonBytes: number
  peakHeapMb: number
  /** What the highlight pool did: dispatched to a worker, cached, or done here. */
  pool: ReturnType<typeof poolStats>
}

async function measure(repository: string, base: string, head: string, withRows: boolean): Promise<Run> {
  const diff = streamMergeBaseDiff(repository, base, head)
  if (!diff)
    throw new Error('Those revisions are not usable')

  const started = performance.now()
  let firstRecordMs = -1
  let files = 0
  let rowRecords = 0
  let truncatedFrom: number | null = null
  let ndjsonBytes = 0
  let peakHeap = 0

  const records = manifestToNdjson(
    // `skipCollapsed` matches what the manifest endpoint asks for. Without it
    // this measures a path the product does not use, and reports the cost of
    // highlighting lock files nobody opened.
    // `skipCollapsed` matches what the manifest endpoint asks for. Without it
    // this measures a path the product does not use, and reports the cost of
    // highlighting lock files nobody opened.
    streamManifest(diff, withRows ? { rows: { layout: 'unified', skipCollapsed: true } } : {}),
  )

  for await (const line of records) {
    if (firstRecordMs < 0)
      firstRecordMs = performance.now() - started

    ndjsonBytes += line.length
    const record = JSON.parse(line) as { t: string, from?: number }

    if (record.t === 'file')
      files++
    else if (record.t === 'rows')
      rowRecords++
    else if (record.t === 'rows-truncated')
      truncatedFrom = record.from ?? null

    // Sampled per record rather than at the end: the point of the streaming
    // design is that nothing accumulates, and a reading taken after the run has
    // finished would miss a peak in the middle of it.
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
  }

  return {
    firstRecordMs: Math.round(firstRecordMs),
    totalMs: Math.round(performance.now() - started),
    files,
    rowRecords,
    truncatedFrom,
    ndjsonBytes,
    peakHeapMb: Math.round(peakHeap / 1024 / 1024),
    pool: poolStats(),
  }
}

/** The middle run of several, which is less swayed by one slow start than a mean. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!
}

const [repository, base, head] = process.argv.slice(2)
const withRows = process.argv.includes('--rows')
const runsIndex = process.argv.indexOf('--runs')
const runs = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 3

if (!repository || !base || !head) {
  console.error('Usage: bun scripts/benchmarks/diff-engine.ts <repo.git> <base> <head> [--rows] [--runs 3]')
  process.exit(1)
}

// One unrecorded run first. The first pass through any of this pays for git's
// own caches and for the JIT, and including it reports a machine warming up.
await measure(repository, base, head, withRows)

const results: Run[] = []
for (let index = 0; index < Math.max(1, runs); index++)
  results.push(await measure(repository, base, head, withRows))

const first = results[0]!
console.log(JSON.stringify({
  repository,
  range: `${base}...${head}`,
  mode: withRows ? 'manifest with inline rows' : 'manifest only',
  runs: results.length,
  files: first.files,
  rowRecords: first.rowRecords,
  truncatedFrom: first.truncatedFrom,
  bytesPerFile: first.files === 0 ? 0 : Math.round(first.ndjsonBytes / first.files),
  ndjsonBytes: first.ndjsonBytes,
  firstRecordMs: median(results.map(run => run.firstRecordMs)),
  totalMs: median(results.map(run => run.totalMs)),
  peakHeapMb: median(results.map(run => run.peakHeapMb)),
  // The last run's, not a median: these are cumulative counters, so the final
  // reading is the whole session and a median of them means nothing.
  pool: results[results.length - 1]!.pool,
}, null, 2))
