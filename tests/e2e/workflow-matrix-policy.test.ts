// `fail-fast`, `max-parallel`, `continue-on-error` and `timeout-minutes`,
// against the real tables.
//
// The rules are unit-tested over plain values in `workflow-matrix-graph`. What
// that cannot check is the half that only exists in the database: that the
// dispatcher copies the policy onto the run, that the claim honours the limit,
// that a report cancels the right sibling rows, and that a job nobody stopped
// is stopped by the sweep. Each of those was a column stored and read by
// nothing until this file existed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { splitLabels } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { isTrue } from '../../app/Actions/Support/sql'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/*
 * One file carrying all four keys, because they interact.
 *
 * `matrix` is a three-way matrix with `max-parallel: 2`, so two may run and the
 * third waits; `flaky` may fail without failing the run; `after` needs the
 * matrix and must not start while any combination is unfinished.
 */
const CI = `name: CI
on: push
jobs:
  matrix:
    runs-on: ubuntu-latest
    strategy:
      max-parallel: 2
      matrix:
        version: ['20', '22', '24']
    steps:
      - run: test
  flaky:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: benchmark
  after:
    needs: matrix
    runs-on: ubuntu-latest
    steps:
      - run: deploy
  slow:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: sleep
`

async function runnerFacts(id: number) {
  const row: any = await db
    .selectFrom('runners')
    .select(['id', 'state', 'scope_type', 'scope_id', 'labels'])
    .where('id', '=', id)
    .executeTakeFirst()

  return {
    id: Number(row.id),
    state: String(row.state),
    scopeType: String(row.scope_type),
    scopeId: row.scope_id === null ? null : Number(row.scope_id),
    labels: splitLabels(row.labels),
  }
}

async function makeRunner(): Promise<any> {
  const row: any = await db
    .insertInto('runners')
    .values({
      name: unique('runner'),
      // Scoped to this repository: an instance runner would take whatever a
      // previous suite left lying around and the test would be asking a
      // different question.
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(unique('tok')),
      labels: 'ubuntu-latest',
      state: 'active',
    })
    .returning(['id'])
    .executeTakeFirst()

  created.runnerIds.push(Number(row.id))

  return runnerFacts(Number(row.id))
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'name', 'state', 'condition_reason', 'fail_fast', 'max_parallel', 'timeout_minutes', 'continue_on_error'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

async function runState(runId: number): Promise<string> {
  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? '')
}

const runs: number[] = []

/**
 * A fresh run of the file above, and the only one a runner can see.
 *
 * The previous test's run is put to bed first. A repository-scoped runner takes
 * the oldest queued job in the repository, so without this each test would be
 * claiming the leftovers of the one before it - which is a test of nothing, and
 * exactly the kind of order-dependence that passes locally and fails in CI.
 */
async function freshRun(headSha: string): Promise<number> {
  for (const previous of runs) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', previous)
      .where('state', 'in', ['blocked', 'queued', 'running', 'cancelling'])
      .execute()
  }

  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha,
  })

  const runId = result.created[0]!

  runs.push(runId)

  return runId
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('mxp')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Matrix Policy', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the matrix policy end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[matrix-policy] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('the policy reaches the run', () => {
  test('every combination carries what the file said, on its own row', async () => {
    if (!available)
      return

    const runId = await freshRun('b'.repeat(40))
    const jobs = await jobsOf(runId)
    const combinations = jobs.filter(job => job.job_id === 'matrix')

    expect(combinations).toHaveLength(3)

    for (const job of combinations)
      expect(Number(job.max_parallel)).toBe(2)

    // Copied onto the run rather than read back from the definition, so a
    // finished run's conclusion stays explicable after the file changes.
    expect(isTrue(jobs.find(job => job.job_id === 'flaky')?.continue_on_error)).toBe(true)
    expect(Number(jobs.find(job => job.job_id === 'slow')?.timeout_minutes)).toBe(5)
    expect(jobs.find(job => job.job_id === 'after')?.state).toBe('blocked')
  }, 60_000)
})

describe('max-parallel', () => {
  test('holds the third combination back until one of the first two is done', async () => {
    if (!available)
      return

    const runId = await freshRun('c'.repeat(40))
    const runner = await makeRunner()

    const taken: string[] = []

    // Six polls, because the run has other jobs: the limit should stop the
    // third *combination*, not stop the runner.
    for (let poll = 0; poll < 6; poll++) {
      const claim = await claimNextJob(runner)

      if (!claim)
        break

      taken.push(claim.jobKey)
    }

    expect(taken.filter(key => key === 'matrix')).toHaveLength(2)
    // The rest of the run is unaffected, which is the half a coarser limit
    // would have broken.
    expect(taken).toContain('flaky')
    expect(taken).toContain('slow')

    const waiting = (await jobsOf(runId)).filter(job => job.job_id === 'matrix' && job.state === 'queued')

    expect(waiting).toHaveLength(1)
  }, 60_000)
})

describe('fail-fast', () => {
  test('one failed combination stops the rest, with the reason on their rows', async () => {
    if (!available)
      return

    const runId = await freshRun('d'.repeat(40))
    const runner = await makeRunner()

    const first = await claimNextJob(runner)
    const second = await claimNextJob(runner)

    expect(first!.jobKey).toBe('matrix')
    expect(second!.jobKey).toBe('matrix')

    await reportJob(runner, { jobId: first!.jobId, state: 'failed', error: 'the tests failed' })

    const jobs = await jobsOf(runId)
    const combinations = jobs.filter(job => job.job_id === 'matrix')

    // The one that failed, the one that was running and has been asked to
    // stop, and the one that never started.
    expect(combinations.map(job => job.state).sort()).toEqual(['cancelled', 'cancelling', 'failed'])

    const stopped = combinations.find(job => job.state === 'cancelled')

    // A cancelled row with no reason is the worst row on a run page: no logs,
    // no failure, and the obvious guess - somebody pressed cancel - is wrong.
    expect(String(stopped?.condition_reason)).toContain('fail-fast')

    /*
     * `after` is still blocked, and that is right: a combination in
     * `cancelling` has been *asked* to stop and has not said it did, so the
     * matrix is unfinished and nothing downstream can be concluded yet.
     */
    expect(jobs.find(job => job.job_id === 'after')?.state).toBe('blocked')

    /*
     * And when nobody acknowledges, the sweep finishes it - through the same
     * settler a report uses. That last part is the fix this test caught: the
     * sweep used to recompute only the run's own state, so a force-cancelled
     * job left `after` in `blocked` forever and the run never reached a
     * terminal state at all.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ lease_expires_at: new Date(Date.now() - 10 * 60_000).toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .where('state', '=', 'cancelling')
      .execute()

    const sweep = await import('../../app/Jobs/ReclaimLapsedLeasesJob')
    await (sweep.default as any).handle()

    const settled = await jobsOf(runId)

    expect(settled.find(job => job.job_id === 'after')?.state).toBe('skipped')

    // The run is not finished, and should not be: `flaky` and `slow` are
    // unrelated jobs nobody has taken yet. A failure ending a run whose other
    // work is still queued would be a verdict the run has not reached.
    expect(await runState(runId)).toBe('queued')
    expect(settled.filter(job => job.state === 'queued').map(job => job.job_id).sort()).toEqual(['flaky', 'slow'])
  }, 60_000)
})

describe('continue-on-error at job level', () => {
  test('the job fails, the run does not, and the row still says failed', async () => {
    if (!available)
      return

    const runId = await freshRun('e'.repeat(40))
    const runner = await makeRunner()

    // Everything green except `flaky`, which is allowed to fail.
    for (let poll = 0; poll < 8; poll++) {
      const claim = await claimNextJob(runner)

      if (!claim)
        break

      await reportJob(runner, {
        jobId: claim.jobId,
        state: claim.jobKey === 'flaky' ? 'failed' : 'succeeded',
        error: claim.jobKey === 'flaky' ? 'the benchmark regressed' : null,
      })
    }

    const jobs = await jobsOf(runId)

    expect(jobs.find(job => job.job_id === 'flaky')?.state).toBe('failed')
    expect(jobs.filter(job => job.state === 'succeeded').length).toBeGreaterThan(0)

    /*
     * The whole point of the key: a red job on a green run. Anything else and
     * people delete the job rather than see it fail, which loses the signal the
     * job existed for.
     */
    expect(await runState(runId)).toBe('succeeded')
  }, 120_000)
})

describe('timeout-minutes', () => {
  test('a job past its deadline is stopped by the sweep, with a reason', async () => {
    if (!available)
      return

    const runId = await freshRun('f'.repeat(40))
    const runner = await makeRunner()

    let slow: any = null

    for (let poll = 0; poll < 8; poll++) {
      const claim = await claimNextJob(runner)

      if (!claim)
        break

      if (claim.jobKey === 'slow')
        slow = claim
    }

    expect(slow).not.toBeNull()

    // Started ten minutes ago against a five-minute timeout. Moving the clock
    // rather than waiting: the rule is about elapsed time, and a test that
    // proves it by sleeping proves it once and costs five minutes every run.
    await db
      .updateTable('workflow_jobs')
      .set({ started_at: new Date(Date.now() - 10 * 60_000).toISOString() } as any)
      .where('id', '=', slow.jobId)
      .execute()

    const sweep = await import('../../app/Jobs/ReclaimLapsedLeasesJob')
    await (sweep.default as any).handle()

    const job = (await jobsOf(runId)).find(row => Number(row.id) === Number(slow.jobId))

    /*
     * `cancelling`, not `failed`. The work is on a machine this instance does
     * not control, and a job declared over while it is still running is a
     * screen telling somebody something untrue - the grace path finishes it
     * when nobody acknowledges.
     */
    expect(job?.state).toBe('cancelling')
    expect(String(job?.condition_reason)).toContain('timeout')
  }, 120_000)
})

/*
 * Priority: which job leaves the queue first.
 *
 * One line long as a use case - a deploy behind two hundred pull request
 * checks waits for all of them, and the deploy is the one somebody is
 * watching - and impossible to add later without changing the claim, which is
 * why it is a column the queue reads rather than a value in a blob.
 */
describe('priority', () => {
  test('a higher-priority job is handed out first, and equal work stays first in first out', async () => {
    if (!available)
      return

    const runId = await freshRun('9a'.repeat(20))
    const runner = await makeRunner()

    // Three jobs added after the run's own, in declaration order, with the
    // last one marked urgent.
    for (const [index, [key, priority]] of ([['first', 0], ['second', 0], ['urgent', 10]] as const).entries()) {
      await db.insertInto('workflow_jobs').values({
        workflow_run_id: runId,
        job_id: `p-${key}`,
        name: key,
        position: 50 + index,
        state: 'queued',
        runs_on: 'ubuntu-latest',
        priority,
      }).execute()
    }

    const taken: string[] = []

    for (let poll = 0; poll < 12; poll++) {
      const claim = await claimNextJob(runner)

      if (!claim)
        break

      if (String(claim.jobKey).startsWith('p-'))
        taken.push(String(claim.jobKey))

      await reportJob(runner, { jobId: claim.jobId, state: 'succeeded' })
    }

    // The urgent one jumps the two ahead of it; those two keep their order,
    // because a queue that reorders equal jobs is one where a build can starve.
    expect(taken).toEqual(['p-urgent', 'p-first', 'p-second'])
  }, 120_000)
})
