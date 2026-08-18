// The operator's numbers.
//
// Every one of these is a figure somebody will act on - buy machines, shut
// machines down, spend a week on a test - so the tests are less about the
// arithmetic than about the cases where a naive version quietly lies: too few
// samples, a clock that went backwards, a cancelled run counted as a failure.

import { describe, expect, test } from 'bun:test'
import {
  costBy,
  elapsed,
  failuresByJob,
  flakyImpact,
  MIN_SAMPLES,
  percentile,
  summarize,
  utilization,
  waitByQueue,
} from '../../app/Ops/insight'

/** A run, with only the fields the statistics look at. */
function run(state: string, durationMs: number | null, jobs = 1, attempts = 1) {
  return { state, durationMs, attempts, jobs }
}

describe('a percentile', () => {
  test('is null until there is enough behind it', () => {
    // Four samples cannot have a 95th percentile: the answer would be the
    // maximum, wearing a name that implies four hundred runs behind it.
    expect(percentile([1, 2, 3, 4], 0.95)).toBeNull()
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5)
  })

  test('is a value that actually occurred', () => {
    /*
     * Nearest-rank, not interpolated. Somebody will paste this number into an
     * argument about whether a pipeline is slow, and "no run ever took that
     * long" ends the argument the wrong way.
     */
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]

    expect(values).toContain(percentile(values, 0.5)!)
    expect(values).toContain(percentile(values, 0.95)!)
    expect(percentile(values, 0.5)).toBe(500)
  })

  test('does not reorder the caller\'s array', () => {
    const values = [5, 1, 4, 2, 3]

    percentile(values, 0.5)

    expect(values).toEqual([5, 1, 4, 2, 3])
  })
})

describe('a window of runs', () => {
  test('does not report a success rate it cannot support', () => {
    const thin = summarize([run('succeeded', 1000), run('failed', 1000)])

    expect(thin.successRate).toBeNull()
    // But the count is always real: "2 runs, no rate yet" is a useful thing to
    // read, and a screen that shows nothing at all reads as broken.
    expect(thin.runs).toBe(2)
    expect(thin.samples).toBe(2)
  })

  test('does not count a cancelled run as a failure', () => {
    /*
     * A superseded run somebody cancelled on purpose is not the pipeline
     * failing, and counting it makes a team that cancels aggressively - which
     * is the behaviour we want - look like the least reliable team here.
     */
    const runs = [
      ...Array.from({ length: MIN_SAMPLES }, () => run('succeeded', 1000)),
      run('cancelled', null),
      run('cancelled', null),
    ]

    expect(summarize(runs).successRate).toBe(1)
  })

  test('measures the retry rate against jobs, not runs', () => {
    // Ten jobs, two of which took a second attempt.
    const runs = [run('succeeded', 1000, 5, 6), run('failed', 1000, 5, 6)]

    expect(summarize(runs).retryRate).toBeCloseTo(0.2, 5)
  })

  test('ignores runs that never finished rather than guessing at them', () => {
    const runs = [
      ...Array.from({ length: MIN_SAMPLES }, () => run('succeeded', 60_000)),
      run('running', null),
    ]

    // The p50 is over the five that finished. A run in flight has no duration,
    // and inventing one from `now` makes every number worse the longer
    // something is stuck.
    expect(summarize(runs).p50).toBe(60_000)
  })
})

describe('failure by job', () => {
  test('ranks by how much a job actually costs, not by its rate', () => {
    const rows = [
      ...Array.from({ length: 40 }, () => ({ name: 'test', state: 'failed' })),
      ...Array.from({ length: 360 }, () => ({ name: 'test', state: 'succeeded' })),
      { name: 'docs', state: 'failed' },
    ]

    const ranked = failuresByJob(rows)

    // `docs` fails 100% of the time and `test` 10%, and `test` is still the one
    // to fix: forty red builds against one.
    expect(ranked[0]?.name).toBe('test')
    expect(ranked[0]?.failures).toBe(40)
    expect(ranked[0]?.runs).toBe(400)
  })

  test('leaves out the jobs that have never failed', () => {
    const listed = failuresByJob([{ name: 'build', state: 'succeeded' }]).map(one => one.name)

    // A list of everything is a list nobody scans.
    expect(listed).toEqual([])
  })
})

describe('queue wait', () => {
  test('is reported per queue, because that is where the decision is', () => {
    const samples = [
      ...Array.from({ length: MIN_SAMPLES }, () => ({ queue: 'gpu', pool: 'main', waitMs: 600_000 })),
      ...Array.from({ length: MIN_SAMPLES }, () => ({ queue: 'default', pool: 'main', waitMs: 1_000 })),
    ]

    const waits = waitByQueue(samples)

    // Averaged together these are five minutes, which describes neither queue:
    // one team cannot ship and the other is fine.
    expect(waits[0]?.queue).toBe('gpu')
    expect(waits[0]?.p95).toBe(600_000)
    expect(waits[1]?.p95).toBe(1_000)
  })

  test('keeps pool and queue names whole', () => {
    // Grouped by a joined key, so a name with a space in it is the case that
    // catches a key parsed back apart.
    const waits = waitByQueue(Array.from({ length: MIN_SAMPLES }, () => ({
      queue: 'build and test',
      pool: 'eu west',
      waitMs: 5_000,
    })))

    expect(waits[0]?.queue).toBe('build and test')
    expect(waits[0]?.pool).toBe('eu west')
    expect(waits[0]?.samples).toBe(MIN_SAMPLES)
  })
})

describe('runner utilization', () => {
  test('puts the idlest machine first, because that is the one to remove', () => {
    const day = 86_400_000

    const listed = utilization([
      { runner: 'busy', busyMs: day * 0.8 },
      { runner: 'idle', busyMs: day * 0.02 },
    ], day)

    expect(listed[0]?.runner).toBe('idle')
    expect(listed[0]?.share).toBeCloseTo(0.02, 5)
  })

  test('never reports more than fully busy', () => {
    // A machine running two jobs at once is busy, not 180% busy - and a share
    // above one reads as a bug in the dashboard rather than a fact about the
    // fleet.
    const listed = utilization([{ runner: 'parallel', busyMs: 200 }], 100)

    expect(listed[0]?.share).toBe(1)
  })
})

describe('cost proxies', () => {
  test('total the minutes and rank the biggest spender first', () => {
    const rows = [
      { key: 'acme/api', durationMs: 600_000 },
      { key: 'acme/api', durationMs: 600_000 },
      { key: 'acme/docs', durationMs: 60_000 },
      // Unfinished work has no minutes yet, and counting it as zero is the same
      // as leaving it out - which is what this does, rather than pretending.
      { key: 'acme/docs', durationMs: null },
    ]

    expect(costBy(rows)).toEqual([
      { key: 'acme/api', minutes: 20 },
      { key: 'acme/docs', minutes: 1 },
    ])
  })
})

describe('flaky impact', () => {
  test('counts runs, not failures, so one test failing twice is one bad run', () => {
    const rows = [
      { runId: 1, failedFlaky: true },
      { runId: 1, failedFlaky: true },
      { runId: 2, failedFlaky: true },
      { runId: 3, failedFlaky: false },
    ]

    const impact = flakyImpact(rows, 10)

    expect(impact.runsFailedByFlaky).toBe(2)
    expect(impact.share).toBeCloseTo(0.2, 5)
  })

  test('withholds the share when there is almost nothing to divide by', () => {
    // "50% of failures are flakes" over two failed runs is a sentence somebody
    // will repeat in a planning meeting.
    expect(flakyImpact([{ runId: 1, failedFlaky: true }], 2).share).toBeNull()
  })
})

describe('elapsed', () => {
  test('refuses a negative duration rather than reporting one', () => {
    /*
     * A finish before a start is a clock that moved, not a run that took
     * negative time - and one negative sample in a percentile is enough to make
     * the whole column wrong in a way nobody can see.
     */
    expect(elapsed('2026-08-17T10:00:00.000Z', '2026-08-17T09:59:00.000Z')).toBeNull()
    expect(elapsed('2026-08-17T10:00:00.000Z', '2026-08-17T10:01:00.000Z')).toBe(60_000)
  })

  test('reads a Date and an ISO string the same way', () => {
    // Half our timestamps are `timestamp` columns and come back as Dates; the
    // other half are strings a runner reported.
    expect(elapsed(new Date('2026-08-17T10:00:00.000Z'), '2026-08-17T10:00:30.000Z')).toBe(30_000)
  })

  test('has no answer when either end is missing', () => {
    expect(elapsed(null, '2026-08-17T10:00:00.000Z')).toBeNull()
    expect(elapsed('2026-08-17T10:00:00.000Z', undefined)).toBeNull()
  })
})
