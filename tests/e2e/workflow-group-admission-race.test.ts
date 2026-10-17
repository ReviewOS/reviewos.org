import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush, startRun } from '../../app/Actions/Workflow/dispatch'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const postgres = ['postgres', 'postgresql'].includes(process.env.DB_CONNECTION || '') ? test : test.skip

interface Fixture {
  db: any
  ownerId: number
  repositoryId: number
  versionId: number
  machine: Parameters<typeof claimNextJob>[0]
  diagnostic: SQL
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error('The PostgreSQL concurrency barrier was not reached')
}

async function withGroup(policy: 'run' | 'skip', use: (fixture: Fixture) => Promise<void>, firstJobs = '') {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  await injectGlobalAutoImports()
  const db = (globalThis as any).db
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const handle = `admit${suffix.slice(0, 12)}`
  let ownerId = 0
  let repositoryId = 0
  let runnerId = 0
  const url = new URL('postgres://127.0.0.1')
  url.hostname = process.env.DB_HOST || '127.0.0.1'
  url.port = process.env.DB_PORT || '5432'
  url.username = process.env.DB_USERNAME || 'postgres'
  url.password = process.env.DB_PASSWORD || ''
  url.pathname = `/${process.env.DB_DATABASE}`
  const diagnostic = new SQL(url.href)
  try {
    const owner = await db.insertInto('users').values({ name: 'Group admission', email: `${handle}@example.com`, handle, password: 'x' }).returning(['id']).executeTakeFirst()
    ownerId = Number(owner.id)
    const repository = await db.insertInto('repositories').values({ owner_type: 'user', owner_id: ownerId, name: handle, visibility: 'public', default_branch: 'main', disk_path: `${handle}/${handle}.git` }).returning(['id']).executeTakeFirst()
    repositoryId = Number(repository.id)
    const runner = await db.insertInto('runners').values({ name: handle, scope_type: 'repository', scope_id: repositoryId, token_hash: suffix.padEnd(64, '0'), state: 'active', labels: 'ubuntu-latest\nself-hosted' }).returning(['id']).executeTakeFirst()
    runnerId = Number(runner.id)
    const machine = { id: runnerId, state: 'active', scopeType: 'repository', scopeId: repositoryId, labels: ['ubuntu-latest', 'self-hosted'] } as Parameters<typeof claimNextJob>[0]
    const synced = await syncWorkflowFile({ repositoryId, ownerType: 'user', ownerId, path: '.github/workflows/admission.yml', sha: 'a'.repeat(40), source: `name: Group admission
on: push
reviewos:
  intermediate: ${policy}
concurrency:
  group: production
jobs:
${firstJobs}  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./ship
` })
    await use({ db, ownerId, repositoryId, versionId: Number(synced.versionId), machine, diagnostic })
  }
  finally {
    await diagnostic.close()
    if (runnerId) await db.deleteFrom('runners').where('id', '=', runnerId).execute()
    if (repositoryId) await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
    if (ownerId) await db.deleteFrom('users').where('id', '=', ownerId).execute()
  }
}

for (const pendingState of ['queued', 'waiting']) {
  postgres(`a grouped run cannot be claimed while replacing an older ${pendingState} run is blocked`, async () => withGroup('skip', async ({ db, ownerId, repositoryId, machine, diagnostic }) => {
    let release = () => {}
    let held: Promise<unknown> | undefined
    let dispatch: ReturnType<typeof dispatchPush> | undefined
    let foreignWrite: Promise<unknown> | undefined
    try {
      await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40) })
      expect(await claimNextJob(machine)).not.toBeNull()
      await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'c'.repeat(40) })
      const pending = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', repositoryId).where('state', '=', 'waiting').executeTakeFirst()
      expect(pending).toBeDefined()
      let ready = () => {}
      const acquired = new Promise<void>(resolve => { ready = resolve })
      const unlock = new Promise<void>(resolve => { release = resolve })
      held = db.transaction(async (tx: any) => {
        await tx.updateTable('workflow_runs').set({ state: pendingState }).where('id', '=', Number(pending.id)).execute()
        ready()
        await unlock
      })
      await acquired
      dispatch = dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'd'.repeat(40) })
      // A database lock establishes that replacement has started but cannot
      // finish. The public claim must refuse the new graph during that window.
      await until(async () => {
        const rows = await diagnostic`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%workflow_runs%'`
        return Number(rows[0].n) > 0
      })
      let foreignWriteCompleted = true
      if (pendingState === 'waiting') {
        // Admission holds its repository lock while a normal foreign-key
        // insert runs independently. A primary-key UPDATE would block this.
        foreignWriteCompleted = false
        foreignWrite = db.insertInto('stars').values({ repository_id: repositoryId, user_id: ownerId }).execute()
        void foreignWrite!.then(() => { foreignWriteCompleted = true })
        await until(async () => foreignWriteCompleted || Number((await diagnostic`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO%stars%'`)[0].n) > 0)
      }
      const compatible = foreignWriteCompleted
      const taken = await claimNextJob(machine)
      release()
      await held
      await dispatch
      await foreignWrite
      expect(compatible).toBe(true)
      expect(taken?.jobId ?? null).toBeNull()
      const runs = await db.selectFrom('workflow_runs').select(['state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
      expect(runs.map((row: any) => String(row.state))).toEqual(['running', 'cancelled', 'waiting'])
    }
    finally {
      release()
      await Promise.allSettled([held, dispatch, foreignWrite].filter(Boolean))
    }
  }), 30_000)
}

postgres('concurrent distinct dispatches get unique run numbers and enter one group in order', async () => withGroup('run', async ({ db, repositoryId, machine, diagnostic }) => {
  let release = () => {}
  let held: Promise<unknown> | undefined
  const dispatches: Array<ReturnType<typeof dispatchPush>> = []
  try {
    let ready = () => {}
    const acquired = new Promise<void>(resolve => { ready = resolve })
    const unlock = new Promise<void>(resolve => { release = resolve })
    held = db.transaction(async (tx: any) => {
      await tx.selectFrom('repositories').select(['id']).where('id', '=', repositoryId).lockForUpdate().executeTakeFirst()
      ready()
      await unlock
    })
    await acquired
    for (const sha of ['b', 'c'])
      dispatches.push(dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: sha.repeat(40) }))
    await until(async () => {
      const rows = await diagnostic`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND (query ILIKE '%repositories%FOR UPDATE%' OR query ILIKE '%UPDATE%repositories%')`
      return Number(rows[0].n) === 2
    })
    release()
    await held
    const results = await Promise.all(dispatches)
    expect(results.map(result => result.created.length)).toEqual([1, 1])
    const runs = await db.selectFrom('workflow_runs').select(['number', 'state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
    expect(runs.map((row: any) => Number(row.number))).toEqual([1, 2])
    expect(runs.map((row: any) => String(row.state))).toEqual(['queued', 'waiting'])
    expect((await claimNextJob(machine))?.jobId).toBeDefined()
    expect(await claimNextJob(machine)).toBeNull()
  }
  finally {
    release()
    await Promise.allSettled([held, ...dispatches].filter(Boolean))
  }
}), 30_000)

postgres('a manually started grouped run keeps its hold through first settle and does not execute a barrier', async () => withGroup('run', async ({ db, repositoryId, versionId, machine }) => {
  const first = await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40) })
  await settleRun(first.created[0]!)
  const firstClaim = await claimNextJob(machine)
  expect(firstClaim?.jobId).toBeDefined()
  const held = await startRun({ values: {
    repository_id: repositoryId, workflow_version_id: versionId, state: 'queued',
    event: 'workflow_dispatch', event_ref: 'refs/heads/main', head_sha: 'c'.repeat(40),
    definition_sha: 'a'.repeat(40), trusted: true, concurrency_group: 'production',
  }, versionId })
  const run = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', held).executeTakeFirst()
  expect(run.state).toBe('waiting')
  const barrier = await db.selectFrom('workflow_jobs').select(['state']).where('workflow_run_id', '=', held).where('job_id', '=', 'ready').executeTakeFirst()
  expect(barrier.state).toBe('blocked')
  expect(await claimNextJob(machine)).toBeNull()
  await settleRun(held)
  expect((await db.selectFrom('workflow_runs').select(['state']).where('id', '=', held).executeTakeFirst()).state).toBe('waiting')
  await reportJob(machine, { jobId: firstClaim!.jobId, state: 'succeeded', exitStatus: 0 })
  expect((await db.selectFrom('workflow_jobs').select(['state']).where('workflow_run_id', '=', held).where('job_id', '=', 'ready').executeTakeFirst()).state).toBe('succeeded')
  expect((await claimNextJob(machine))?.jobId).toBeDefined()
}, '  ready:\n    reviewos:\n      wait: true\n'), 30_000)

postgres('failed replacement rolls back its graph and the older run and job cancellations', async () => withGroup('skip', async ({ db, repositoryId, machine }) => {
  await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40) })
  expect((await claimNextJob(machine))?.jobId).toBeDefined()
  await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'c'.repeat(40) })
  const pending = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', repositoryId).where('state', '=', 'waiting').executeTakeFirst()
  const constraint = `admission_${crypto.randomUUID().replaceAll('-', '')}`
  // Only PostgreSQL DDL can inject this database failure after replacement
  // changes the parent. The private fixture owns the table and constraint;
  // existing rows remain valid, and the constraint is removed in finally.
  await db.unsafe(`ALTER TABLE workflow_jobs ADD CONSTRAINT "${constraint}" CHECK (workflow_run_id <> ${Number(pending.id)} OR state <> 'cancelled') NOT VALID`)
  try {
    await expect(dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'd'.repeat(40) })).rejects.toThrow()
    const runs = await db.selectFrom('workflow_runs').select(['state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
    expect(runs.map((row: any) => String(row.state))).toEqual(['running', 'waiting'])
    const job = await db.selectFrom('workflow_jobs').select(['state']).where('workflow_run_id', '=', Number(pending.id)).where('job_id', '=', 'ship').executeTakeFirst()
    expect(job.state).toBe('queued')
  }
  finally {
    await db.unsafe(`ALTER TABLE workflow_jobs DROP CONSTRAINT "${constraint}"`)
  }
}), 30_000)
