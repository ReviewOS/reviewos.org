// A running job is stopped only by a decision about that job, and its runner
// hears the decision.
//
// HQ's `api-e2e` (2026-11-08, run 3648) ended "The instance revoked this job's
// lease: 401 Unknown job credential" while it was passing, with a newer run
// waiting in its concurrency group. The newer run had nothing to do with it:
// the job had reached its own `timeout-minutes: 40`, the sweep revoked its
// lease, and every endpoint answered the still-valid token "unknown". So this
// pins both halves: newer runs joining the group never touch the running job's
// credential, and a job stopped on purpose is told why, with a 409 that carries
// the instance's reason instead of a 401.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { cancelRun } from '../../app/Actions/Workflow/cancel'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerId: 0 }

let available = false
let db: any = null
let server: any = null
let sweep: any = null
let port = 0
let shas = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: false
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - run: bun test
`

async function call(path: string, body: Record<string, unknown>, token: string) {
  const answer = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => ({})) as any }
}

async function push(): Promise<number> {
  shas += 1
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: String(shas).padStart(40, '0'),
  })

  return result.created[0]!
}

async function run(id: number): Promise<any> {
  return db.selectFrom('workflow_runs').select(['id', 'number', 'state', 'conclusion_reason']).where('id', '=', id).executeTakeFirst()
}

/** Start a run and hand its job to the runner, as a claim would. */
async function claimed(): Promise<{ runId: number, jobId: number, token: string }> {
  const runId = await push()
  const answer = await call('/runner/claim', {}, TOKEN)
  expect(answer.status).toBe(200)
  expect(Number(answer.body.job?.run?.id ?? runId)).toBe(runId)

  return { runId, jobId: Number(answer.body.job.id), token: String(answer.body.job.token) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    sweep = (await import('../../app/Jobs/ReclaimLapsedLeasesJob')).default
    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('rsj')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Stopped job', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner.id)

    created.name = unique('repo')
    const repository: any = await db.insertInto('repositories')
      .values({ owner_type: 'user', owner_id: created.ownerId, name: created.name, visibility: 'public', default_branch: 'main', disk_path: `${created.handle}/${created.name}.git` })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository.id)

    const runner: any = await db.insertInto('runners')
      .values({ name: unique('runner'), scope_type: 'repository', scope_id: created.repositoryId, token_hash: hashToken(TOKEN), labels: 'ubuntu-latest', state: 'active' })
      .returning(['id']).executeTakeFirst()
    created.runnerId = Number(runner.id)

    await syncWorkflowFile({ repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId, path: '.github/workflows/ci.yml', source: CI, sha: 'a'.repeat(40) })

    available = true
  }
  catch (error) {
    console.warn(`[runner-stopped-job] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('a running job and the runs behind it', () => {
  test('newer runs joining its group never touch its credential', async () => {
    if (!available)
      return

    const held = await claimed()
    expect((await call('/runner/heartbeat', {}, held.token)).status).toBe(200)

    // Two more pushes: one waits behind the running run, the next replaces it.
    const second = await push()
    expect(String((await run(second)).state)).toBe('waiting')
    const third = await push()
    expect(String((await run(second)).state)).toBe('cancelled')
    expect(String((await run(third)).state)).toBe('waiting')

    // The running job was not part of either decision.
    expect((await call('/runner/heartbeat', {}, held.token)).status).toBe(200)
    expect((await call('/runner/logs', { sequence: 1, content: 'still going\n' }, held.token)).status).toBe(200)
    expect(String((await run(held.runId)).state)).toBe('running')

    // A sweep with nothing overdue leaves it alone too.
    await sweep.handle({})
    expect((await call('/runner/heartbeat', {}, held.token)).status).toBe(200)

    // Finished, so the next test starts from a quiet group.
    expect((await call('/runner/report', { state: 'succeeded' }, held.token)).status).toBe(200)
  }, 60_000)
})

describe('a job stopped on purpose', () => {
  test('at its timeout, is told so with a 409 rather than "Unknown job credential"', async () => {
    if (!available)
      return

    // Whatever the previous test released, finished, so the claim gets a fresh run.
    await db.updateTable('workflow_runs').set({ state: 'cancelled' }).where('repository_id', '=', created.repositoryId).where('state', 'in', ['queued', 'waiting']).execute()
    await db.updateTable('workflow_jobs').set({ state: 'cancelled' }).where('repository_id', '=', created.repositoryId).where('state', 'in', ['queued', 'blocked']).execute()

    const held = await claimed()
    // Forty-one minutes in, against `timeout-minutes: 40`.
    await db.updateTable('workflow_jobs').set({ started_at: new Date(Date.now() - 41 * 60_000).toISOString() }).where('id', '=', held.jobId).execute()
    await sweep.handle({})

    const beat = await call('/runner/heartbeat', {}, held.token)
    expect(beat.status).toBe(409)
    expect(beat.body.error).toBe('This job ran past its 40-minute timeout.')

    // Every job endpoint gives the same answer, not only the heartbeat.
    const log = await call('/runner/logs', { sequence: 2, content: 'x\n' }, held.token)
    expect(log.status).toBe(409)
    expect(log.body.error).toBe('This job ran past its 40-minute timeout.')

    // And the run says which job and which limit, rather than reading as
    // somebody having cancelled it.
    expect(String((await run(held.runId)).conclusion_reason)).toBe('Job `e2e` ran past its 40-minute timeout.')

    // The runner's acknowledgement is still accepted.
    expect((await call('/runner/report', { state: 'cancelled', error: `The instance stopped this job: ${beat.body.error}` }, held.token)).status).toBe(200)
  }, 60_000)

  test('when its own run is cancelled, is told the reason given', async () => {
    if (!available)
      return

    await db.updateTable('workflow_runs').set({ state: 'cancelled' }).where('repository_id', '=', created.repositoryId).where('state', 'in', ['queued', 'waiting']).execute()
    await db.updateTable('workflow_jobs').set({ state: 'cancelled' }).where('repository_id', '=', created.repositoryId).where('state', 'in', ['queued', 'blocked']).execute()

    const held = await claimed()
    const number = Number((await run(held.runId)).number)
    const cancelled = await cancelRun({ repositoryId: created.repositoryId, number, reason: 'Superseded by a newer commit', actor: { externalActor: 'test' } })
    expect(cancelled.status).toBe(200)

    const beat = await call('/runner/heartbeat', {}, held.token)
    expect(beat.status).toBe(409)
    expect(beat.body.error).toBe('Superseded by a newer commit')
  }, 60_000)

  test('a credential that names no job is still a 401', async () => {
    if (!available)
      return

    expect((await call('/runner/heartbeat', {}, 'job-not-a-real-token')).status).toBe(401)
  })
})
