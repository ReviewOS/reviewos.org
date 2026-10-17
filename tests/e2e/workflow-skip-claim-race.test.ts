import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const postgres = ['postgres', 'postgresql'].includes(process.env.DB_CONNECTION || '') ? test : test.skip

for (const expired of [false, true]) {
  postgres(expired ? 'an expired lease cannot resurrect a job that finished before reclaim' : 'skip preserves a claim blocked on its job rather than handing out a cancelled run', async () => {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const handle = `race${suffix.slice(0, 12)}`
    let ownerId = 0
    let repositoryId = 0
    let runnerId = 0
    let release = () => {}
    let held: Promise<unknown> | undefined
    let claim: ReturnType<typeof claimNextJob> | undefined
    let dispatch: ReturnType<typeof dispatchPush> | undefined
    const url = new URL('postgres://127.0.0.1')
    url.hostname = process.env.DB_HOST || '127.0.0.1'
    url.port = process.env.DB_PORT || '5432'
    url.username = process.env.DB_USERNAME || 'postgres'
    url.password = process.env.DB_PASSWORD || ''
    url.pathname = `/${process.env.DB_DATABASE}`
    const diagnostic = new SQL(url.href)
    async function until(check: () => Promise<boolean>) {
      const end = Date.now() + 5000
      while (Date.now() < end) {
        if (await check()) return
        await Bun.sleep(20)
      }
      throw new Error('The PostgreSQL concurrency barrier was not reached')
    }
    try {
      const owner = await db.insertInto('users').values({ name: 'Claim race', email: `${handle}@example.com`, handle, password: 'x' }).returning(['id']).executeTakeFirst()
      ownerId = Number(owner.id)
      const repository = await db.insertInto('repositories').values({ owner_type: 'user', owner_id: ownerId, name: handle, visibility: 'public', default_branch: 'main', disk_path: `${handle}/${handle}.git` }).returning(['id']).executeTakeFirst()
      repositoryId = Number(repository.id)
      const runner = await db.insertInto('runners').values({ name: handle, scope_type: 'repository', scope_id: repositoryId, token_hash: suffix.padEnd(64, '0'), state: 'active', labels: 'ubuntu-latest\nself-hosted' }).returning(['id']).executeTakeFirst()
      runnerId = Number(runner.id)
      await syncWorkflowFile({ repositoryId, ownerType: 'user', ownerId, path: '.github/workflows/race.yml', sha: 'a'.repeat(40), source: `name: Claim race
on: push
reviewos:
  intermediate: skip
concurrency:
  group: claim-race
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./ship
  after:
    needs: ship
    runs-on: ubuntu-latest
    steps:
      - run: ./after
` })
      await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40) })
      const first = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', repositoryId).executeTakeFirst()
      const job = await db.selectFrom('workflow_jobs').select(['id']).where('workflow_run_id', '=', Number(first.id)).where('job_id', '=', 'ship').executeTakeFirst()
      if (expired) {
        await db.updateTable('workflow_runs').set({ state: 'running' }).where('id', '=', Number(first.id)).execute()
        await db.updateTable('workflow_jobs').set({ state: 'running', runner_id: String(runnerId + 10_000), lease_expires_at: new Date(Date.now() - 600_000).toISOString() }).where('id', '=', Number(job.id)).execute()
      }
      let ready = () => {}
      const acquired = new Promise<void>(resolve => { ready = resolve })
      const unlock = new Promise<void>(resolve => { release = resolve })
      held = db.transaction(async (tx: any) => {
        if (expired)
          await tx.updateTable('workflow_runs').set({ state: 'running' }).where('id', '=', Number(first.id)).execute()
        else
          await tx.updateTable('workflow_jobs').set({ state: 'queued' }).where('id', '=', Number(job.id)).execute()
        ready()
        await unlock
      })
      await acquired
      claim = claimNextJob({ id: runnerId, state: 'active', scopeType: 'repository', scopeId: repositoryId, labels: ['ubuntu-latest', 'self-hosted'] } as any)
      // PostgreSQL's lock diagnostics establish the actual interleaving. A sleep
      // cannot prove that the claim has reached the held job on a slower host.
      const statement = expired ? '%UPDATE%workflow_runs%' : '%UPDATE%workflow_jobs%'
      await until(async () => Number((await diagnostic`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE ${statement}`)[0].n) > 0)
      if (expired) {
        await db.updateTable('workflow_jobs').set({ state: 'failed' }).where('id', '=', Number(job.id)).execute()
        release()
        await held
        expect(await claim).toBeNull()
        const terminal = await db.selectFrom('workflow_jobs').select(['state']).where('id', '=', Number(job.id)).executeTakeFirst()
        expect(terminal.state).toBe('failed')
        return
      }
      dispatch = dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'c'.repeat(40) })
      await until(async () => (await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', repositoryId).execute()).length === 2)
      release()
      await held
      const [taken] = await Promise.all([claim, dispatch])
      expect(taken?.jobId).toBe(Number(job.id))
      const runs = await db.selectFrom('workflow_runs').select(['state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
      expect(runs.map((row: any) => String(row.state))).toEqual(['running', 'waiting'])
      const remaining = await db.selectFrom('workflow_jobs').select(['state']).where('workflow_run_id', '=', Number(first.id)).where('job_id', '=', 'after').executeTakeFirst()
      expect(remaining.state).toBe('blocked')
    }
    finally {
      release()
      await Promise.allSettled([held, claim, dispatch].filter(Boolean))
      await diagnostic.close()
      if (runnerId) await db.deleteFrom('runners').where('id', '=', runnerId).execute()
      if (repositoryId) await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
      if (ownerId) await db.deleteFrom('users').where('id', '=', ownerId).execute()
    }
  }, 30_000)
}
