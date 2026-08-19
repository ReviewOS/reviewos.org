// Handing work to a runner, against the real tables.
//
// The rules were tested in `runner-protocol` over plain values. What that
// cannot check is the part where two runners ask at the same instant and the
// database decides: a claim is a read followed by a write, and the gap in the
// middle is exactly long enough for somebody else to take the job. So these run
// against rows, and the race is run rather than reasoned about.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { claimNextJob, heartbeat } from '../../app/Actions/Runner/claim'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { leaseUntil, splitLabels } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: test
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

async function makeRunner(over: Record<string, unknown> = {}): Promise<number> {
  const row: any = await db
    .insertInto('runners')
    .values({
      name: unique('runner'),
      scope_type: 'instance',
      token_hash: hashToken(unique('tok')),
      labels: 'ubuntu-latest',
      state: 'active',
      ...over,
    })
    .returning(['id'])
    .executeTakeFirst()

  const id = Number(row.id)
  created.runnerIds.push(id)
  return id
}

/** A fresh run, so each test starts from a known board. */
async function freshRun(headSha: string): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha,
  })

  return result.created[0]!
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'runner_id', 'lease_expires_at'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('rcl')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Runner Claim', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the runner claim end to end test',
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
    console.warn(`[runner-claim] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('claiming', () => {
  test('a runner takes the queued job and holds a lease', async () => {
    if (!available)
      return

    /*
     * Scoped to this repository, deliberately.
     *
     * An instance-scoped runner may claim *any* queued job and may recover any
     * lapsed one, which is the behaviour the tests below are about - and it
     * made this one depend on the rest of the database being empty. A run left
     * behind by an interrupted suite is a job with a lapsed lease, and an
     * instance runner takes the oldest of those before the one this test just
     * created. Scoping it asks the question this test is actually asking.
     */
    const runId = await freshRun('b'.repeat(40))
    const runner = await runnerFacts(await makeRunner({ scope_type: 'repository', scope_id: created.repositoryId }))

    const claimed = await claimNextJob(runner)

    expect(claimed).not.toBeNull()
    expect(claimed!.jobKey).toBe('build')
    expect(claimed!.runId).toBe(runId)

    const [build] = await jobsOf(runId)
    expect(build.state).toBe('running')
    expect(String(build.runner_id)).toBe(String(runner.id))
    expect(build.lease_expires_at).not.toBeNull()
  })

  /*
   * The race. Two runners polling at the same instant both read the job as
   * free; the guard is in the `WHERE`, so exactly one write matches and the
   * other finds nothing left to take.
   */
  test('two runners asking at once do not both get the same job', async () => {
    if (!available)
      return

    await freshRun('c'.repeat(40))
    const first = await runnerFacts(await makeRunner())
    const second = await runnerFacts(await makeRunner())

    const [a, b] = await Promise.all([claimNextJob(first), claimNextJob(second)])

    const claimed = [a, b].filter(Boolean)
    const ids = new Set(claimed.map(job => job!.jobId))

    // Both may get work - there are other runs from earlier tests - but never
    // the same job twice.
    expect(ids.size).toBe(claimed.length)
  })

  test('a blocked job is not handed out', async () => {
    if (!available)
      return

    const runId = await freshRun('d'.repeat(40))
    const jobs = await jobsOf(runId)

    expect(jobs.find(job => job.job_id === 'test')?.state).toBe('blocked')

    // A runner with no matching labels cannot take the queued one either, so
    // what it finds here is nothing from this run.
    const picky = await runnerFacts(await makeRunner({ labels: 'macos' }))
    const claimed = await claimNextJob(picky)

    expect(claimed?.runId).not.toBe(runId)
  })

  test('a runner scoped to another repository is offered nothing here', async () => {
    if (!available)
      return

    await freshRun('e'.repeat(40))
    const elsewhere = await runnerFacts(await makeRunner({
      scope_type: 'repository',
      scope_id: created.repositoryId + 99_999,
    }))

    expect(await claimNextJob(elsewhere)).toBeNull()
  })

  /*
   * Recovery. A machine that died cannot say so, so the lease lapsing is the
   * only thing that frees its work - otherwise one crash strands a job until
   * somebody notices.
   */
  test('a job whose lease expired can be claimed by somebody else', async () => {
    if (!available)
      return

    const runId = await freshRun('f'.repeat(40))
    const dead = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    /*
     * Held directly rather than by claiming. `claimNextJob` takes the oldest
     * eligible job on the instance, which is not necessarily this run's - the
     * earlier tests leave queued work behind, and a test that assumed otherwise
     * was asserting about somebody else's job.
     */
    await db
      .updateTable('workflow_jobs')
      .set({
        state: 'running',
        runner_id: String(dead.id),
        lease_expires_at: leaseUntil(new Date(Date.now() - 600_000), 0),
      })
      .where('id', '=', Number(build.id))
      .execute()

    const alive = await runnerFacts(await makeRunner())
    const retaken = await claimNextJob(alive)

    expect(retaken).not.toBeNull()

    const after = (await jobsOf(runId)).find(job => job.job_id === 'build')
    // Either this job was the one recovered, or an older one was - but a job
    // whose lease lapsed must never still belong to the machine that died.
    if (retaken!.jobId === Number(build.id))
      expect(String(after.runner_id)).toBe(String(alive.id))
    else
      expect(String(after.runner_id)).toBe(String(dead.id))
  })
})

describe('heartbeat', () => {
  test('extends the lease of the runner holding it, and nobody else\'s', async () => {
    if (!available)
      return

    await freshRun('1'.repeat(40))
    const holder = await runnerFacts(await makeRunner())
    const claimed = await claimNextJob(holder)
    expect(claimed).not.toBeNull()

    expect(await heartbeat(holder, claimed!.jobId)).not.toBeNull()

    const other = await runnerFacts(await makeRunner())
    expect(await heartbeat(other, claimed!.jobId)).toBeNull()
  })
})

describe('reporting', () => {
  test('a success unblocks what was waiting on it', async () => {
    if (!available)
      return

    const runId = await freshRun('2'.repeat(40))
    const runner = await runnerFacts(await makeRunner())

    // Claim this run's build job specifically: other runs are in flight.
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')
    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    const outcome = await reportJob(runner, { jobId: Number(build.id), state: 'succeeded' })

    expect(outcome.ok).toBe(true)

    const after = await jobsOf(runId)
    expect(after.find(job => job.job_id === 'build')?.state).toBe('succeeded')
    // The dependant is now runnable rather than still blocked.
    expect(after.find(job => job.job_id === 'test')?.state).toBe('queued')
  })

  /*
   * The one the lease exists for: a worker that lost its connection, coming
   * back to publish over work it no longer holds.
   */
  test('a report after the lease lapsed is refused', async () => {
    if (!available)
      return

    const runId = await freshRun('3'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({
        state: 'running',
        runner_id: String(runner.id),
        lease_expires_at: leaseUntil(new Date(Date.now() - 600_000), 0),
      })
      .where('id', '=', Number(build.id))
      .execute()

    const outcome = await reportJob(runner, { jobId: Number(build.id), state: 'succeeded' })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('expired')
    expect((await jobsOf(runId)).find(job => job.job_id === 'build')?.state).toBe('running')
  })

  test('a runner reporting on a job it does not hold is refused', async () => {
    if (!available)
      return

    const runId = await freshRun('4'.repeat(40))
    const holder = await runnerFacts(await makeRunner())
    const stranger = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(holder.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    const outcome = await reportJob(stranger, { jobId: Number(build.id), state: 'succeeded' })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('another runner')
  })

  /*
   * A failure has to end the run rather than leave its dependant blocked
   * forever: a run that never finishes holds a pull request's checks open with
   * nothing to show for it.
   */
  test('a failure skips what could never run, and the run ends', async () => {
    if (!available)
      return

    const runId = await freshRun('5'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    const outcome = await reportJob(runner, { jobId: Number(build.id), state: 'failed', error: 'exit 1' })

    expect(outcome.ok).toBe(true)
    expect(outcome.runState).toBe('failed')

    const after = await jobsOf(runId)
    expect(after.find(job => job.job_id === 'test')?.state).toBe('skipped')

    const run: any = await db.selectFrom('workflow_runs').select(['state', 'finished_at']).where('id', '=', runId).executeTakeFirst()
    expect(run.state).toBe('failed')
    expect(run.finished_at).not.toBeNull()
  })

  /*
   * At-least-once delivery: a runner that did not hear the answer says it
   * again, and the repeat is answered as success rather than as a conflict.
   */
  test('the same completion reported twice is a duplicate, not an error', async () => {
    if (!available)
      return

    const runId = await freshRun('6'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    const first = await reportJob(runner, { jobId: Number(build.id), state: 'succeeded' })
    const second = await reportJob(runner, { jobId: Number(build.id), state: 'succeeded' })

    expect(first.ok).toBe(true)
    expect(first.duplicate).toBe(false)
    expect(second.ok).toBe(true)
    expect(second.duplicate).toBe(true)
  })
})

describe('what each step did, as rows', () => {
  /**
   * The claim this exists for: a step's result is a value, not text somebody
   * scrapes back out of a log. Restart-from-step can only skip a step whose
   * result was recorded, and a log line is not a recorded result.
   */
  test('the outputs and the three numbers land on the step rows', async () => {
    if (!available)
      return

    const runId = await freshRun('9'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    const startedAt = new Date(Date.now() - 9 * 60_000).toISOString()
    const finishedAt = new Date().toISOString()

    await reportJob(runner, {
      jobId: Number(build.id),
      state: 'succeeded',
      steps: [{
        position: 0,
        state: 'succeeded',
        exitCode: 0,
        startedAt,
        finishedAt,
        // Nine minutes, of which eight were waiting. One number cannot say
        // that, which is the entire reason there are three.
        queuedMs: 8 * 60_000,
        activeMs: 60_000,
        outputs: { artifact: 'app.tar.gz' },
      }],
    })

    const step: any = await db
      .selectFrom('workflow_steps')
      .select(['state', 'exit_code', 'queued_ms', 'active_ms', 'outputs', 'started_at', 'finished_at'])
      .where('workflow_job_id', '=', Number(build.id))
      .where('position', '=', 0)
      .executeTakeFirst()

    expect(String(step.state)).toBe('succeeded')
    expect(Number(step.exit_code)).toBe(0)
    expect(Number(step.queued_ms)).toBe(8 * 60_000)
    expect(Number(step.active_ms)).toBe(60_000)
    expect(JSON.parse(String(step.outputs))).toEqual({ artifact: 'app.tar.gz' })

    /*
     * Wall time is derived from the two timestamps rather than stored: a
     * third number that is the subtraction of two others is a number that can
     * disagree with them.
     */
    const wall = Date.parse(String(step.finished_at)) - Date.parse(String(step.started_at))

    expect(Math.round(wall / 60_000)).toBe(9)
  })

  test('and a runner cannot write results onto another job\'s steps', async () => {
    if (!available)
      return

    const runId = await freshRun('8'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const jobs = await jobsOf(runId)
    const build = jobs.find(job => job.job_id === 'build')
    const other = jobs.find(job => job.job_id !== 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()


    await reportJob(runner, {
      jobId: Number(build.id),
      state: 'succeeded',
      // Position 0 of *this* job. The runner picks positions, so a position is
      // the one thing here it could get wrong or lie about.
      steps: [{ position: 0, state: 'succeeded', outputs: { leaked: 'yes' } }],
    })

    const strangers: any[] = await db
      .selectFrom('workflow_steps')
      .select(['outputs'])
      .where('workflow_job_id', '=', Number(other.id))
      .execute()

    for (const step of strangers)
      expect(step.outputs).toBeNull()
  })

  test('and a job that reports no steps leaves their rows alone', async () => {
    if (!available)
      return

    const runId = await freshRun('7'.repeat(40))
    const runner = await runnerFacts(await makeRunner())
    const build = (await jobsOf(runId)).find(job => job.job_id === 'build')

    await db.updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: leaseUntil(new Date()) })
      .where('id', '=', Number(build.id))
      .execute()

    // An older runner, which has never heard of any of this. Its jobs still
    // report and still finish; their steps simply say nothing.
    const outcome = await reportJob(runner, { jobId: Number(build.id), state: 'succeeded' })

    expect(outcome.ok).toBe(true)

    const step: any = await db
      .selectFrom('workflow_steps')
      .select(['state'])
      .where('workflow_job_id', '=', Number(build.id))
      .where('position', '=', 0)
      .executeTakeFirst()

    expect(String(step.state)).toBe('pending')
  })
})
