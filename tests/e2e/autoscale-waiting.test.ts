// What an autoscaled runner group counts as work waiting for it.
//
// The scaler reads queued jobs straight from the database, joined to their
// runs for the repository, because a group scaled to zero has no machines to
// attribute work to. This runs that query for real.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function aQueuedJob(runsOn: string, state = 'queued'): Promise<void> {
  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: Math.floor(Math.random() * 1_000_000),
    state: 'queued',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: 'f'.repeat(40),
    definition_sha: 'f'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    repository_id: created.repositoryId,
    job_id: unique('job'),
    name: 'test',
    position: 1,
    state,
    runs_on: runsOn,
  }).execute()
}

function group(labels: string[], repositories = [`${created.handle}/${created.name}`]): any {
  return { name: 'test-group', region: 'us-east-1', repositories, labels }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_jobs').select(['id']).limit(1).execute()

    created.handle = unique('scale')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Scale', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.reviewos/workflows/ci.ts',
      name: 'CI',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.workflowId = Number(workflow.id)

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'f'.repeat(40),
      source_path: '.reviewos/workflows/ci.ts',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version.id)

    await aQueuedJob('ubuntu-latest')
    await aQueuedJob('self-hosted\naws')
    await aQueuedJob('macos-latest')
    await aQueuedJob('ubuntu-latest', 'running')
    available = true
  }
  catch (error) {
    console.warn(`[autoscale] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

const runnerIds: number[] = []

async function aRunner(name: string): Promise<number> {
  const runner: any = await db.insertInto('runners').values({
    name,
    scope_type: 'instance',
    scope_id: null,
    token_hash: unique('hash').padEnd(64, '0').slice(0, 64),
    labels: 'ubuntu-latest\nself-hosted\naws',
    state: 'active',
    version: '1',
    last_seen_at: new Date().toISOString(),
  }).returning(['id']).executeTakeFirst()
  runnerIds.push(Number(runner.id))
  return Number(runner.id)
}

afterAll(async () => {
  if (!available || !db)
    return

  if (runnerIds.length > 0)
    await db.deleteFrom('runners').where('id', 'in', runnerIds).execute().catch(() => null)
  await db.deleteFrom('workflows').where('id', '=', created.workflowId).execute().catch(() => null)
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => null)
})

describe('work waiting for an autoscaled group', () => {
  test('counts the queued jobs of its repositories whose labels it carries', async () => {
    if (!available)
      return

    const { waitingFor } = await import('../../app/Actions/Runner/Autoscale/tick')

    expect(await waitingFor(group(['ubuntu-latest', 'self-hosted', 'aws']))).toBe(2)
    expect(await waitingFor(group(['ubuntu-latest']))).toBe(1)
  }, 120_000)

  test('is nothing for a repository it does not serve', async () => {
    if (!available)
      return

    const { waitingFor } = await import('../../app/Actions/Runner/Autoscale/tick')

    expect(await waitingFor(group(['ubuntu-latest'], ['nobody/nothing']))).toBe(0)
  }, 120_000)
})

describe('the machines an autoscaled group already has', () => {
  /*
   * `workflow_jobs.runner_id` is text and `runners.id` is a number. Asking for
   * the jobs those runners hold by number failed in Postgres with "operator
   * does not exist: character varying = integer" - on every tick that had a
   * machine to count, which is every tick that mattered: the group could not
   * see which of its machines were busy, so it could neither grow past them
   * nor let an idle one go.
   */
  test('tells a busy machine from an idle one', async () => {
    if (!available)
      return

    const busyName = unique('i-0')
    const idleName = unique('i-0')
    const busy = await aRunner(busyName)
    await aRunner(idleName)
    await aQueuedJob('ubuntu-latest', 'running')
    await db.updateTable('workflow_jobs')
      .set({ runner_id: String(busy), lease_expires_at: new Date(Date.now() + 600_000).toISOString() })
      .where('repository_id', '=', created.repositoryId)
      .where('state', '=', 'running')
      .execute()

    const { workersFor } = await import('../../app/Actions/Runner/Autoscale/tick')
    const workers = await workersFor([busyName, idleName, 'i-0nobody'])

    expect(workers.find(worker => worker.name === busyName)?.idle).toBe(false)
    expect(workers.find(worker => worker.name === idleName)?.idle).toBe(true)
    expect(workers).toHaveLength(2)
  }, 120_000)
})

describe('a tick that changes nothing', () => {
  /*
   * A group stuck at a desired capacity whose launches never arrive believes
   * enough machines are on the way, so it asks for nothing more. It used to
   * say nothing too, which on production read exactly like an idle queue.
   */
  test('still says what it saw when work is waiting', async () => {
    if (!available)
      return

    const { tickGroup } = await import('../../app/Actions/Runner/Autoscale/tick')
    const api: any = {
      region: 'us-east-1',
      describeGroup: async () => ({ desired: 3, instances: [] }),
      setDesired: async () => { throw new Error('nothing to change, so nothing should be set') },
      terminate: async () => { throw new Error('nothing to reap') },
    }

    const lines = await tickGroup(api, { ...group(['ubuntu-latest', 'self-hosted', 'aws']), min: 0, max: 6, registrationGraceSeconds: 900 } as any)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('waiting, desired 3, 0 instance(s)')
    expect(lines[0]).toContain('nothing to change')
  }, 120_000)
})
