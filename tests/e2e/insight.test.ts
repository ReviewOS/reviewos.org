// The operator dashboard, against real rows.
//
// The unit tests hold the arithmetic. This holds what only the database can be
// wrong about: that the six numbers are computed from the tables they claim to
// read, that the repository scope actually excludes the other repository's
// runs, and that the queue wait is measured from `queued_at` rather than from
// when the run was created - which is the difference between "add runners" and
// "your dependency graph is deep".

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { insightFor } from '../../app/Ops/insight'

const created = {
  ownerId: 0,
  handle: '',
  repositoryId: 0,
  otherRepositoryId: 0,
  workflowId: 0,
  versionId: 0,
  poolId: 0,
  queueId: 0,
  runnerId: 0,
  suiteId: 0,
  flakyTestId: 0,
  freshTestId: 0,
  runIds: [] as number[],
}

let available = false
let db: any = null
let server: any = null
let port = 0
let repositoryName = ''

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Minutes ago, as the ISO string these columns hold. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

async function insert(table: string, values: Record<string, unknown>): Promise<number> {
  const row: any = await db.insertInto(table).values(values as any).returning(['id']).executeTakeFirst()

  return Number(row?.id)
}

/**
 * A finished run with one job on it.
 *
 * `startedMinutesAgo` and the durations are explicit rather than derived,
 * because every number under test is a difference between two timestamps and a
 * fixture that computes them the same way the code does proves nothing.
 */
async function seedRun(input: {
  repositoryId: number
  state: string
  startedMinutesAgo: number
  runMinutes: number
  jobName: string
  jobState: string
  waitSeconds?: number
  attempt?: number
}): Promise<number> {
  const runId = await insert('workflow_runs', {
    workflow_version_id: created.versionId,
    repository_id: input.repositoryId,
    number: created.runIds.length + 1,
    state: input.state,
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: unique('sha').padEnd(40, '0').slice(0, 40),
    definition_sha: 'b'.repeat(40),
    started_at: ago(input.startedMinutesAgo),
    finished_at: ago(input.startedMinutesAgo - input.runMinutes),
  })

  const wait = input.waitSeconds ?? 60

  await insert('workflow_jobs', {
    workflow_run_id: runId,
    job_id: input.jobName,
    name: input.jobName,
    position: 1,
    state: input.jobState,
    attempt: input.attempt ?? 1,
    runner_id: String(created.runnerId),
    queued_at: new Date(Date.parse(ago(input.startedMinutesAgo)) - wait * 1000).toISOString(),
    started_at: ago(input.startedMinutesAgo),
    finished_at: ago(input.startedMinutesAgo - input.runMinutes),
  })

  created.runIds.push(runId)

  return runId
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('ins')
    created.ownerId = await insert('users', {
      name: 'Insight Owner',
      email: `${created.handle}@example.com`,
      handle: created.handle,
      password: 'x',
    })

    repositoryName = unique('repo')
    created.repositoryId = await insert('repositories', {
      owner_type: 'user',
      owner_id: created.ownerId,
      name: repositoryName,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${unique('repo')}.git`,
    })

    created.otherRepositoryId = await insert('repositories', {
      owner_type: 'user',
      owner_id: created.ownerId,
      name: unique('other'),
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${unique('other')}.git`,
    })

    created.workflowId = await insert('workflows', {
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/ci.yml',
      name: 'CI',
      state: 'active',
    })

    created.versionId = await insert('workflow_versions', {
      workflow_id: created.workflowId,
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/ci.yml',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    })

    created.poolId = await insert('runner_pools', { name: 'Main', slug: unique('pool') })
    created.queueId = await insert('runner_queues', {
      runner_pool_id: created.poolId,
      name: 'default',
      state: 'active',
    })

    created.runnerId = await insert('runners', {
      name: unique('runner'),
      scope_type: 'instance',
      token_hash: unique('hash').padEnd(64, '0').slice(0, 64),
      state: 'active',
      runner_queue_id: created.queueId,
    })

    /*
     * Six runs: five green and one red, each a different length, so the
     * percentiles have something to choose between and the success rate has
     * enough behind it to be reported at all.
     */
    for (let index = 0; index < 5; index++) {
      await seedRun({
        repositoryId: created.repositoryId,
        state: 'succeeded',
        startedMinutesAgo: 120 + index * 10,
        runMinutes: 2 + index,
        jobName: 'build',
        jobState: 'succeeded',
      })
    }

    const failed = await seedRun({
      repositoryId: created.repositoryId,
      state: 'failed',
      startedMinutesAgo: 60,
      runMinutes: 10,
      jobName: 'test',
      jobState: 'failed',
      // Ten minutes in the queue, on a run that took ten minutes: the wait is
      // half the wall-clock and is invisible in the run duration.
      waitSeconds: 600,
      attempt: 2,
    })

    // Somebody else's repository, in the same window, on the same fleet.
    await seedRun({
      repositoryId: created.otherRepositoryId,
      state: 'succeeded',
      startedMinutesAgo: 30,
      runMinutes: 45,
      jobName: 'build',
      jobState: 'succeeded',
    })

    /*
     * A test that was already known flaky before this run reported, and one
     * that this run is the first to fail. Only the first is an argument for
     * anything, and telling them apart is the whole point of `flaky_since`.
     */
    created.suiteId = await insert('test_suites', {
      repository_id: created.repositoryId,
      name: 'Unit',
      slug: unique('suite'),
    })

    created.flakyTestId = await insert('managed_tests', {
      test_suite_id: created.suiteId,
      name: 'known flake',
      state: 'enabled',
      flaky: true,
      flaky_reason: 'Passed and failed on the same commit.',
      flaky_since: ago(10_000),
    })

    created.freshTestId = await insert('managed_tests', {
      test_suite_id: created.suiteId,
      name: 'discovered today',
      state: 'enabled',
      flaky: true,
      flaky_reason: 'Passed only after a retry.',
      // After the results came in, which is what "we learned it from this run"
      // looks like in the row.
      flaky_since: new Date().toISOString(),
    })

    const testRunId = await insert('test_runs', {
      test_suite_id: created.suiteId,
      head_sha: 'c'.repeat(40),
      branch: 'main',
      workflow_run_id: failed,
      external_key: unique('key'),
      source: 'junit',
      failed: 2,
    })

    for (const testId of [created.flakyTestId, created.freshTestId]) {
      await insert('test_executions', {
        test_run_id: testRunId,
        managed_test_id: testId,
        result: 'failed',
      })
    }

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[insight] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    for (const id of [created.repositoryId, created.otherRepositoryId]) {
      if (id)
        await db.deleteFrom('repositories').where('id', '=', id).execute()
    }

    if (created.queueId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.poolId)
      await db.deleteFrom('runner_pools').where('id', '=', created.poolId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('one repository over a window', () => {
  test('reports the runs, the rate, and the percentiles from real rows', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })

    expect(insight.overall.runs).toBe(6)
    // Five of six finished green.
    expect(insight.overall.successRate).toBeCloseTo(5 / 6, 3)
    expect(insight.overall.p50).toBeGreaterThan(0)
    expect(insight.overall.p95).toBeGreaterThanOrEqual(insight.overall.p50!)
    // The other repository's forty-five-minute run is not in this scope, so the
    // p95 cannot have reached it.
    expect(insight.overall.p95).toBeLessThan(45 * 60_000)
  }, 120_000)

  test('names the workflow and attributes the runs to it', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })
    const ci = insight.workflows.find(one => one.path === '.github/workflows/ci.yml')

    expect(ci?.workflow).toBe('CI')
    expect(ci?.runs).toBe(6)
  }, 120_000)

  test('says which job the failures are in', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })

    expect(insight.failuresByJob[0]?.name).toBe('test')
    expect(insight.failuresByJob[0]?.failures).toBe(1)
    // `build` never failed, so it is not in a list read to find what to fix.
    expect(insight.failuresByJob.map(one => one.name)).not.toContain('build')
  }, 120_000)

  test('measures the queue wait from when a runner could have taken the job', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })
    const wait = insight.wait.find(one => one.queue === 'default')

    expect(wait?.pool).toBe('Main')
    expect(wait?.samples).toBe(6)
    /*
     * The ten-minute wait is the p95, and the run it belongs to took ten
     * minutes - so a dashboard measuring from `created_at` would have reported
     * twenty and sent somebody shopping for machines that were never the
     * problem.
     */
    expect(wait?.p95).toBe(600_000)
    expect(wait?.p50).toBe(60_000)
  }, 120_000)

  test('counts the fleet\'s busy time and what it did not do', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })
    const runner = insight.runners[0]

    expect(runner?.busyMs).toBeGreaterThan(0)
    // One machine, a handful of minutes of work, a week of window: this is a
    // fleet with room, and the number should say so rather than round to
    // something reassuring.
    expect(runner?.share).toBeLessThan(0.01)
  }, 120_000)

  test('totals the minutes by repository, owner, and queue', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })

    expect(insight.cost.owners[0]?.key).toBe(created.handle)
    expect(insight.cost.owners[0]?.minutes).toBeGreaterThan(0)
    expect(insight.cost.repositories[0]?.key).toContain(`${created.handle}/`)
    expect(insight.cost.queues[0]?.key).toBe('default')
  }, 120_000)

  test('blames only the flake we already knew about', async () => {
    if (!available)
      return

    const insight = await insightFor({ repositoryId: created.repositoryId, days: 7 })

    /*
     * Two flaky tests failed in that run and one of them was discovered by it.
     * Counting both would make the cost of flakiness rise every time detection
     * improved, which is the opposite of what the number is for - and it is one
     * run either way, because the unit is the run somebody had to re-trigger.
     */
    expect(insight.flaky.runsFailedByFlaky).toBe(1)
    expect(insight.flaky.failedRuns).toBe(1)
  }, 120_000)
})

describe('the instance-wide view', () => {
  test('includes what the repository scope excluded', async () => {
    if (!available)
      return

    const scoped = await insightFor({ repositoryId: created.repositoryId, days: 7 })
    const everything = await insightFor({ days: 7 })

    expect(everything.overall.runs).toBeGreaterThan(scoped.overall.runs)

    const owner = everything.cost.owners.find(one => one.key === created.handle)

    // The forty-five minute run in the other repository is this owner's too, so
    // the owner total is larger than the one repository's.
    expect(owner?.minutes).toBeGreaterThan(scoped.cost.owners[0]!.minutes)
  }, 120_000)

  test('a window that predates everything reports nothing rather than failing', async () => {
    if (!available)
      return

    // A fresh instance, and an instance whose window has moved past the data,
    // look the same. Both should read as "nothing here", not as an error page.
    const empty = await insightFor({ repositoryId: created.repositoryId, days: 1, now: Date.now() + 30 * 86_400_000 })

    expect(empty.overall.runs).toBe(0)
    expect(empty.overall.successRate).toBeNull()
    expect(empty.wait).toEqual([])
  }, 120_000)
})

describe('over HTTP', () => {
  test('serves a repository\'s numbers in the shape the screen renders', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/insight?owner=${created.handle}&repo=${repositoryName}&days=7`,
      { headers: { Accept: 'application/json' } },
    )

    expect(answer.status).toBe(200)

    const body: any = await answer.json()

    expect(body.window.days).toBe(7)
    expect(body.overall.runs).toBe(6)
    // snake_case on the wire, and the nulls survive it: a client generated from
    // the document has to be able to tell "too few runs" from "nothing passed".
    expect(body.overall.success_rate).toBeCloseTo(0.833, 2)
    expect(body.wait[0].p95_ms).toBe(600_000)
    expect(body.runners[0].idle_ms).toBeGreaterThan(0)
    expect(body.flaky.runs_failed_by_known_flaky).toBe(1)
  }, 120_000)

  test('refuses the instance-wide view to somebody who is not an administrator', async () => {
    if (!available)
      return

    /*
     * 404 rather than 403. Fleet-wide utilization and per-owner minutes
     * describe every tenant here, and whether this instance has a fleet at all
     * is not a fact to confirm to a stranger by the shape of a refusal.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/insight`, { headers: { Accept: 'application/json' } })

    expect(answer.status).toBe(404)
  }, 120_000)

  test('clamps an absurd window instead of erroring, and says what it used', async () => {
    if (!available)
      return

    // A window is a dial somebody drags; one that breaks at the end of its
    // travel is a worse answer than one that stops.
    const answer = await fetch(
      `http://127.0.0.1:${port}/api/insight?owner=${created.handle}&repo=${repositoryName}&days=4000`,
      { headers: { Accept: 'application/json' } },
    )

    expect(answer.status).toBe(200)
    expect((await answer.json()).window.days).toBe(90)
  }, 120_000)
})
