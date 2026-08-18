// The deploy lock, against the claim.
//
// `reviewos: { concurrency-group: production }` is a limit shared by every job
// wearing that name, in any run of any workflow here. The unit tests hold the
// parsing; this holds the only thing that matters - that a runner asking for
// work is told no while somebody else holds the lock, and that the queue comes
// out in the order it went in.
//
// Its own repository, because the answer to "what did the claim hand out" means
// nothing in one that has other work queued in it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { reportJob } from '../../app/Actions/Runner/report'

const created = { ownerId: 0, repositoryId: 0, runnerId: 0, handle: '', name: '', versionId: 0 }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

function machine(): any {
  return {
    id: created.runnerId,
    state: 'active',
    scopeType: 'repository',
    scopeId: created.repositoryId,
    labels: ['ubuntu-latest', 'self-hosted'],
  }
}

/**
 * One run with one job in the named group.
 *
 * Written straight into the tables rather than dispatched from a file: the
 * dispatcher is tested elsewhere, and what this file is about is what the claim
 * does with several runs that already exist.
 */
async function queueDeploy(number: number, group = 'production', method = 'ordered', limit = 1): Promise<number> {
  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number,
    state: 'queued',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: unique('s').padEnd(40, '0').slice(0, 40),
    definition_sha: 'b'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  const job: any = await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    job_id: 'deploy',
    name: `Deploy ${number}`,
    position: 0,
    state: 'queued',
    runs_on: 'ubuntu-latest',
    settings: JSON.stringify({ concurrency: { group, limit, method } }),
  }).returning(['id']).executeTakeFirst()

  return Number(job.id)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('lock')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Lock', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const workflow: any = await db
      .insertInto('workflows')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        repository_id: created.repositoryId,
        path: '.github/workflows/deploy.yml',
        name: 'Deploy',
        state: 'active',
      })
      .returning(['id'])
      .executeTakeFirst()

    const version: any = await db
      .insertInto('workflow_versions')
      .values({
        workflow_id: Number(workflow.id),
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/deploy.yml',
        content_digest: unique('d').padEnd(64, '0').slice(0, 64),
        on_push: true,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.versionId = Number(version.id)

    const runner: any = await db
      .insertInto('runners')
      .values({
        name: unique('runner'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: unique('h').padEnd(64, '0').slice(0, 64),
        state: 'active',
        labels: 'ubuntu-latest\nself-hosted',
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.runnerId = Number(runner?.id)

    available = true
  }
  catch (error) {
    console.warn(`[named-concurrency] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
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

describe('a lock of one', () => {
  test('hands out one job and then nothing, across two runs', async () => {
    if (!available)
      return

    const first = await queueDeploy(1)
    const second = await queueDeploy(2)

    const one = await claimNextJob(machine())

    expect(Number(one?.jobId)).toBe(first)

    /*
     * Two separate runs, and the second is not offered while the first holds
     * the lock. Actions' run-level `concurrency:` cannot express this: the two
     * deploys may live in different workflows.
     */
    expect(await claimNextJob(machine())).toBeNull()

    // The lock is released by the job finishing, not by a timer.
    await reportJob(machine(), { jobId: first, state: 'succeeded' } as any)

    expect(Number((await claimNextJob(machine()))?.jobId)).toBe(second)

    // Released again, so the next test starts with the lock free rather than
    // with this test's leftovers holding it.
    await reportJob(machine(), { jobId: second, state: 'succeeded' } as any)
  }, 120_000)
})

describe('ordering', () => {
  test('ordered hands out the oldest waiting job, whatever the poll order', async () => {
    if (!available)
      return

    // Three at once, and the queue must come out in the order it went in: a
    // deploy queue that reorders lands an older commit after a newer one.
    const ids = [await queueDeploy(11), await queueDeploy(12), await queueDeploy(13)]
    const taken: number[] = []

    for (let poll = 0; poll < 3; poll++) {
      const claim = await claimNextJob(machine())

      if (!claim)
        break

      taken.push(Number(claim.jobId))
      await reportJob(machine(), { jobId: Number(claim.jobId), state: 'succeeded' } as any)
    }

    expect(taken).toEqual(ids)
  }, 120_000)

  test('eager lets a later job go while an earlier one waits its turn', async () => {
    if (!available)
      return

    /*
     * The other case the attribute is for: four jobs sharing one licence
     * server, where the group is a resource limit rather than a sequence and
     * nobody cares which goes first.
     */
    const older = await queueDeploy(21, 'licences', 'eager', 2)
    const newer = await queueDeploy(22, 'licences', 'eager', 2)

    const first = await claimNextJob(machine())
    const second = await claimNextJob(machine())

    expect([Number(first?.jobId), Number(second?.jobId)].sort()).toEqual([older, newer].sort())

    // And the third would wait, because two is the limit.
    const third = await queueDeploy(23, 'licences', 'eager', 2)

    expect(await claimNextJob(machine())).toBeNull()

    for (const id of [Number(first?.jobId), Number(second?.jobId)])
      await reportJob(machine(), { jobId: id, state: 'succeeded' } as any)

    expect(Number((await claimNextJob(machine()))?.jobId)).toBe(third)
  }, 120_000)
})

describe('a group is a name, not a job', () => {
  test('two different job names in one group still share the limit', async () => {
    if (!available)
      return

    /*
     * The shared staging environment: a smoke test and a deploy are different
     * jobs in different workflows, and the environment is one. A limit keyed on
     * the job's own name - which is what `max-parallel` does - cannot say that.
     */
    const deploy = await queueDeploy(31, 'staging')

    await db
      .updateTable('workflow_jobs')
      .set({ job_id: 'smoke', name: 'Smoke' } as any)
      .where('id', '=', await queueDeploy(32, 'staging'))
      .execute()

    const one = await claimNextJob(machine())

    expect(Number(one?.jobId)).toBe(deploy)
    expect(await claimNextJob(machine())).toBeNull()

    await reportJob(machine(), { jobId: deploy, state: 'succeeded' } as any)

    const two = await claimNextJob(machine())

    expect(String((two as any)?.jobKey)).toBe('smoke')
  }, 120_000)
})
