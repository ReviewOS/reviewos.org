import { expect, test } from 'bun:test'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

// Exercise dispatch, claim and report against real rows. This catches a run
// losing its remaining work between stages; rollout and runner execution are
// separate acceptance boundaries.
test('skip preserves a started run between stages and replaces only its unstarted successor', async () => {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  await injectGlobalAutoImports()
  const db = (globalThis as any).db
  const handle = `stages${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  let ownerId = 0
  let repositoryId = 0
  let runnerId = 0
  try {
    const owner = await db.insertInto('users').values({ name: 'Stage transition', email: `${handle}@example.com`, handle, password: 'x' }).returning(['id']).executeTakeFirst()
    ownerId = Number(owner.id)
    const repository = await db.insertInto('repositories').values({ owner_type: 'user', owner_id: ownerId, name: handle, visibility: 'public', default_branch: 'main', disk_path: `${handle}/${handle}.git` }).returning(['id']).executeTakeFirst()
    repositoryId = Number(repository.id)
    const runner = await db.insertInto('runners').values({ name: handle, scope_type: 'repository', scope_id: repositoryId, token_hash: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'), state: 'active', labels: 'ubuntu-latest\nself-hosted' }).returning(['id']).executeTakeFirst()
    runnerId = Number(runner.id)
    const facts = { id: runnerId, state: 'active', scopeType: 'repository', scopeId: repositoryId, labels: ['ubuntu-latest', 'self-hosted'] }
    await syncWorkflowFile({ repositoryId, ownerType: 'user', ownerId, path: '.github/workflows/stages.yml', sha: 'a'.repeat(40), source: `name: Stages
on: push
reviewos:
  intermediate: skip
concurrency:
  group: stages
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: ./test
` })
    const dispatch = async (sha: string) => (await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha: sha.repeat(40) })).created[0]!
    const first = await dispatch('b')
    const build = await claimNextJob(facts)
    expect(build?.runId).toBe(first)
    expect((await reportJob(facts, { jobId: build!.jobId, state: 'succeeded' })).ok).toBe(true)
    const between = await db.selectFrom('workflow_runs').select(['state', 'started_at']).where('id', '=', first).executeTakeFirst()
    expect(between.state).toBe('queued')
    expect(between.started_at).not.toBeNull()

    const second = await dispatch('c')
    const third = await dispatch('d')
    const runs = await db.selectFrom('workflow_runs').select(['state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
    expect(runs.map((row: any) => row.state)).toEqual(['queued', 'cancelled', 'waiting'])
    const next = await claimNextJob(facts)
    expect(next?.runId).toBe(first)
    expect((await reportJob(facts, { jobId: next!.jobId, state: 'succeeded' })).ok).toBe(true)
    const finished = await db.selectFrom('workflow_runs').select(['id', 'state']).where('repository_id', '=', repositoryId).orderBy('id').execute()
    expect(finished.map((row: any) => [Number(row.id), row.state])).toEqual([[first, 'succeeded'], [second, 'cancelled'], [third, 'queued']])
    expect((await claimNextJob(facts))?.runId).toBe(third)
  }
  finally {
    if (runnerId) await db.deleteFrom('runners').where('id', '=', runnerId).execute()
    if (repositoryId) await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
    if (ownerId) await db.deleteFrom('users').where('id', '=', ownerId).execute()
  }
}, 30_000)
