/**
 * What happens to everything else while a large compare is being rendered.
 *
 * Every other benchmark here measures one stream in isolation, and that is
 * exactly the thing that cannot see the reason the highlight pool exists. A
 * server that renders a five thousand file compare on its event loop answers
 * that request eventually and answers *every other request* after it - so the
 * number that matters is not how long the compare took, it is what a page load
 * cost somebody who arrived while it was running.
 *
 * The shape:
 *
 *   1. Measure a small request, repeatedly, on an idle server. That is the
 *      baseline, and it has to be measured rather than assumed because it
 *      includes the database, the router and whatever else the machine is
 *      doing.
 *   2. Start a large compare streaming, and keep measuring the same small
 *      request while it runs.
 *   3. Report the difference at the median and at the tail.
 *
 * The tail is the point. A median that barely moves and a p99 of two seconds is
 * a server that is unusable for one request in a hundred, and a mean would hide
 * it completely.
 *
 * Usage:
 *   bun scripts/benchmarks/under-load.ts <base> <compare-path> <probe-path>
 *
 * Example:
 *   bun scripts/benchmarks/under-load.ts http://localhost:3000 \
 *     '/api/repos/pulls/diff/manifest?owner=stacks&repo=stacks&number=9003' \
 *     '/api/health'
 */

interface Sample {
  ms: number
  ok: boolean
}

/** One request, timed to its last byte rather than to its first. */
async function timed(url: string): Promise<Sample> {
  const started = performance.now()

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    // Drained, because a response that has only sent its headers has not cost
    // the server what it is going to cost.
    await response.arrayBuffer()

    return { ms: performance.now() - started, ok: response.ok }
  }
  catch {
    return { ms: performance.now() - started, ok: false }
  }
}

/** Probe repeatedly until told to stop, pacing so the probe is not the load. */
async function probeUntil(url: string, done: () => boolean, everyMs: number): Promise<Sample[]> {
  const samples: Sample[] = []

  while (!done()) {
    samples.push(await timed(url))
    await Bun.sleep(everyMs)
  }

  return samples
}

function percentile(samples: readonly Sample[], fraction: number): number {
  if (samples.length === 0)
    return 0

  const sorted = [...samples].map(sample => sample.ms).sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))

  return Math.round(sorted[at]! * 10) / 10
}

function summarize(samples: readonly Sample[]) {
  return {
    requests: samples.length,
    failed: samples.filter(sample => !sample.ok).length,
    p50: percentile(samples, 0.5),
    p90: percentile(samples, 0.9),
    p99: percentile(samples, 0.99),
    worst: percentile(samples, 1),
  }
}

export async function measureUnderLoad(options: {
  base: string
  comparePath: string
  probePath: string
  /** How long to measure the idle baseline for. */
  baselineMs?: number
  probeEveryMs?: number
}): Promise<Record<string, unknown>> {
  const { base, comparePath, probePath, baselineMs = 3_000, probeEveryMs = 50 } = options
  const probeUrl = `${base}${probePath}`

  // One request first, unmeasured. The first one through pays for connection
  // setup, for any lazily built singleton, and for the JIT.
  await timed(probeUrl)

  const baselineEnd = performance.now() + baselineMs
  const baseline = await probeUntil(probeUrl, () => performance.now() > baselineEnd, probeEveryMs)

  // The load. Started and then drained in the background, with the probe
  // running against the same server the whole time.
  let streaming = true
  const started = performance.now()

  const compare = fetch(`${base}${comparePath}`, { headers: { Accept: 'application/x-ndjson' } })
    .then(response => response.arrayBuffer())
    .then((body) => {
      streaming = false
      return { bytes: body.byteLength, ms: performance.now() - started }
    })
    .catch(() => {
      streaming = false
      return { bytes: 0, ms: performance.now() - started }
    })

  const underLoad = await probeUntil(probeUrl, () => !streaming, probeEveryMs)
  const load = await compare

  const idle = summarize(baseline)
  const loaded = summarize(underLoad)

  return {
    probe: probePath,
    load: { path: comparePath, ...load, bytes: undefined, megabytes: Math.round(load.bytes / 1024 / 1024 * 10) / 10 },
    idle,
    underLoad: loaded,
    // The answer, stated rather than left to be worked out from two tables.
    cost: {
      p50: Math.round((loaded.p50 - idle.p50) * 10) / 10,
      p99: Math.round((loaded.p99 - idle.p99) * 10) / 10,
      worst: Math.round((loaded.worst - idle.worst) * 10) / 10,
    },
  }
}

if (import.meta.main) {
  const [base, comparePath, probePath] = process.argv.slice(2)

  if (!base || !comparePath) {
    console.error(
      'Usage: bun scripts/benchmarks/under-load.ts <base> <compare-path> [probe-path]\n'
      + 'Example: bun scripts/benchmarks/under-load.ts http://localhost:3000 \\\n'
      + "  '/api/repos/pulls/diff/manifest?owner=stacks&repo=stacks&number=9003' '/api/health'",
    )
    process.exit(1)
  }

  const result = await measureUnderLoad({
    base,
    comparePath,
    probePath: probePath ?? '/api/health',
  })

  console.log(JSON.stringify(result, null, 2))
}
