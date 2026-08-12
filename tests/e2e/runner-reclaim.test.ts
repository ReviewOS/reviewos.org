// Work that comes back when a runner stops talking.
//
// The case is a machine that died: it cannot report, cannot heartbeat, and
// cannot be asked. Until this sweep existed the only thing that freed its job
// was another runner happening to poll - which is exactly what does not happen
// on the instance where it matters, the one whose fleet is busy elsewhere.
//
// Both directions are tested, and the second is the one that would do damage:
// the sweep must never take work from a machine that is still alive.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { leaseUntil } from '../../app/Actions/Runner/protocol'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null
let sweep: any = null

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
`

async function freshRun(headSha: string): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha,
  })

  return result.created[0]!
}

async function buildJob(runId: number): Promise<any> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'state', 'runner_id', 'lease_expires_at'])
    .where('workflow_run_id', '=', runId)
    .where('job_id', '=', 'build')
    .executeTakeFirst()
}

/** Hold a job as a runner would, with a lease that is live or long gone. */
async function hold(jobId: number, runnerId: string, expiresAt: string): Promise<void> {
  await db
    .updateTable('workflow_jobs')
    .set({ state: 'running', runner_id: runnerId, lease_expires_at: expiresAt })
    .where('id', '=', jobId)
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    sweep = (await import('../../app/Jobs/ReclaimLapsedLeasesJob')).default

    created.handle = unique('rcm')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Reclaim', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the lease reclaim end to end test',
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
    console.warn(`[runner-reclaim] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('a runner that stopped talking', () => {
  test('has its job returned to the queue', async () => {
    if (!available)
      return

    const runId = await freshRun('b'.repeat(40))
    const job = await buildJob(runId)

    await hold(Number(job.id), '9001', leaseUntil(new Date(Date.now() - 600_000), 0))

    await sweep.handle({})

    const after = await buildJob(runId)
    expect(after.state).toBe('queued')
    expect(after.runner_id).toBeNull()
    expect(after.lease_expires_at).toBeNull()
  })

  /*
   * Requeued rather than failed. A lapsed lease means the control plane stopped
   * hearing from a runner, not that the work failed - it may even have
   * succeeded with the report lost on the way back. Failing it would report a
   * verdict nobody reached.
   */
  test('and is not marked failed on its behalf', async () => {
    if (!available)
      return

    const runId = await freshRun('c'.repeat(40))
    const job = await buildJob(runId)

    await hold(Number(job.id), '9002', leaseUntil(new Date(Date.now() - 600_000), 0))
    await sweep.handle({})

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['state', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirst()

    expect(run.state).toBe('queued')
    expect(run.finished_at).toBeNull()
  })

  // A running job with no lease at all is a row that lost its holder. Skipping
  // it would leave the one case that cannot recover itself.
  test('a job held with no lease at all is reclaimed too', async () => {
    if (!available)
      return

    const runId = await freshRun('d'.repeat(40))
    const job = await buildJob(runId)

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: '9003', lease_expires_at: null })
      .where('id', '=', Number(job.id))
      .execute()

    await sweep.handle({})

    expect((await buildJob(runId)).state).toBe('queued')
  })
})

describe('a runner that is still alive', () => {
  /*
   * The direction that would do damage. Taking work from a machine that is
   * mid-build gives two runners the same job, and the control plane believing
   * one of them.
   */
  test('keeps its job', async () => {
    if (!available)
      return

    const runId = await freshRun('e'.repeat(40))
    const job = await buildJob(runId)

    await hold(Number(job.id), '9004', leaseUntil(new Date()))

    await sweep.handle({})

    const after = await buildJob(runId)
    expect(after.state).toBe('running')
    expect(String(after.runner_id)).toBe('9004')
  })

  test('and a sweep with nothing to do reports nothing', async () => {
    if (!available)
      return

    const result: any = await sweep.handle({})

    expect(result.ok).toBe(true)
  })
})

describe('a run that already finished', () => {
  // A late lease expiring underneath a finished run must not reopen it.
  test('is not reopened by the sweep', async () => {
    if (!available)
      return

    const runId = await freshRun('f'.repeat(40))
    const job = await buildJob(runId)

    await hold(Number(job.id), '9005', leaseUntil(new Date(Date.now() - 600_000), 0))
    await db.updateTable('workflow_runs').set({ state: 'succeeded' }).where('id', '=', runId).execute()

    await sweep.handle({})

    const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
    expect(run.state).toBe('succeeded')
  })
})
