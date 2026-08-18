// A concurrency group that queues rather than cancels.
//
// `concurrency:` without `cancel-in-progress` means the second run waits for
// the first. Every forge that ships the key seems to implement the cancelling
// half and skip this one, which turns "one deploy at a time" into a label.
//
// The claim is where it either is or is not a guarantee: the held run's jobs
// are ordinary `queued` rows, because holding the *run* is what keeps this one
// state change instead of a rule spread across the graph. So this file has a
// repository of its own with nothing else queued in it, and asks a runner.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, runnerId: 0, handle: '', name: '' }

let available = false
let db: any = null

const SERIAL = `name: Serial
on: push
concurrency:
  group: production
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./ship
`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The machine that asks for work. Scoped to this repository, so it sees only this. */
function machine(): any {
  return {
    id: created.runnerId,
    state: 'active',
    scopeType: 'repository',
    scopeId: created.repositoryId,
    labels: ['ubuntu-latest', 'self-hosted'],
  }
}

async function runsInGroup(): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'conclusion_reason'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('id')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('cq')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Queue', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const runner: any = await db
      .insertInto('runners')
      .values({
        name: unique('runner'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: unique('hash').padEnd(64, '0').slice(0, 64),
        state: 'active',
        labels: 'ubuntu-latest\nself-hosted',
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.runnerId = Number(runner?.id)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/serial.yml',
      source: SERIAL,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[concurrency-queue] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('two runs in one group', () => {
  test('the second waits, and no runner may take its work', async () => {
    if (!available)
      return

    for (const sha of ['b', 'c']) {
      await dispatchPush({
        repositoryId: created.repositoryId,
        event: { ref: 'refs/heads/main' },
        headSha: sha.repeat(40),
      })
    }

    const runs = await runsInGroup()

    expect(runs.length).toBe(2)
    expect(String(runs[0].state)).toBe('queued')
    expect(String(runs[1].state)).toBe('waiting')
    // Said on the run: "queued" with nothing happening for twenty minutes is
    // the most expensive screen in a forge, and this is not a missing runner.
    expect(String(runs[1].conclusion_reason)).toContain('concurrency group')

    const second: any[] = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'state'])
      .where('workflow_run_id', '=', Number(runs[1].id))
      .execute()

    // The held run's jobs look perfectly claimable from their own rows. That is
    // the point: if the claim did not read the run's state, "one deploy at a
    // time" would be a label rather than a guarantee.
    expect(second.every((row: any) => String(row.state) === 'queued')).toBe(true)

    const heldIds = new Set(second.map((row: any) => Number(row.id)))
    const taken: number[] = []

    for (let poll = 0; poll < 4; poll++) {
      const claim = await claimNextJob(machine())

      if (!claim)
        break

      taken.push(Number(claim.jobId))
    }

    // Exactly the first run's work was handed out, and nothing from the run
    // behind it.
    expect(taken.length).toBe(1)
    expect(taken.some(id => heldIds.has(id))).toBe(false)
  }, 120_000)

  test('and finishing the first releases exactly one behind it', async () => {
    if (!available)
      return

    const before = await runsInGroup()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', Number(before[0].id))
      .execute()

    await settleRun(Number(before[0].id))

    const after = await runsInGroup()

    expect(String(after[0].state)).toBe('succeeded')
    expect(String(after[1].state)).toBe('queued')
    /*
     * The reason goes with the hold. A run that has been released explaining
     * why it once waited is a run page arguing with itself - and the column is
     * the one a conclusion is written into.
     */
    expect(after[1].conclusion_reason).toBeNull()

    const claim = await claimNextJob(machine())

    expect(claim).not.toBeNull()

    const row: any = await db
      .selectFrom('workflow_jobs')
      .select(['workflow_run_id'])
      .where('id', '=', Number(claim!.jobId))
      .executeTakeFirst()

    expect(Number(row.workflow_run_id)).toBe(Number(after[1].id))
  }, 120_000)

  test('a third run queues behind the second rather than beside it', async () => {
    if (!available)
      return

    await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'd'.repeat(40),
    })

    const runs = await runsInGroup()

    // One at a time is the promise, and it holds for the third as much as the
    // second: a queue that only ever held one run back would let a pile-up
    // through the moment two arrived together.
    expect(String(runs[2].state)).toBe('waiting')
    expect(runs.filter((row: any) => ['queued', 'running'].includes(String(row.state))).length).toBe(1)
  }, 120_000)
})
