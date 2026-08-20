// A whole pipeline, driven to its conclusion by a runner that executes nothing.
//
// Every feature here is tested on its own somewhere else. What is not tested
// anywhere else is the interaction: a fan-out, a barrier, a gate and a
// fail-fast are four rules that meet in one graph, and the meeting is where the
// bugs are.
//
// The harness calls `claimNextJob` and `reportJob` - the two functions the
// runner endpoints wrap - so every transition here is the one production makes.
// Writing this by hand would mean twenty `updateTable` calls that quietly
// bypass exactly the rules under test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { fakeRunner } from '../helpers/fakeRunner'
import type { FakeRunner } from '../helpers/fakeRunner'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null
let runner: FakeRunner | null = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Two independent jobs, a barrier that waits for both, a gate, and a deploy.
 *
 * Deliberately the shape of a real pipeline rather than the smallest graph that
 * exercises the code: the bugs this is for are the ones where a barrier settles
 * before its second dependency reports.
 */
const PIPELINE = `name: Pipeline
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: make lint
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
  ready:
    needs: [lint, test]
    reviewos:
      wait: true
  approve:
    needs: [ready]
    reviewos:
      block: Ship it?
  deploy:
    needs: [approve]
    runs-on: ubuntu-latest
    steps:
      - run: make deploy
`

async function statesOf(runId: number): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state'])
    .where('workflow_run_id', '=', runId)
    .execute()

  return Object.fromEntries(rows.map((row: any) => [String(row.job_id), String(row.state)]))
}

async function runState(runId: number): Promise<string> {
  const row: any = await db
    .selectFrom('workflow_runs')
    .select(['state'])
    .where('id', '=', runId)
    .executeTakeFirst()

  return String(row?.state ?? '')
}

/** A fresh run of the pipeline, because a repeat of one push is a redelivery. */
async function start(): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  return Number(result.created[0])
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('pipe')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Pipeline', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/pipeline.yml',
      source: PIPELINE,
      sha: 'a'.repeat(40),
    })

    runner = await fakeRunner({ db, labels: ['ubuntu-latest'] })

    available = true
  }
  catch (error) {
    console.warn(`[pipeline] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    await runner?.remove()

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a pipeline that goes the way it was written', () => {
  test('runs both halves, closes the barrier, and stops at the gate', async () => {
    if (!available)
      return

    const runId = await start()
    const done = await runner!.drain()

    // Both independent jobs were taken, in whichever order the queue offered
    // them - the order is the scheduler's business and not this test's.
    expect(done.map(one => one.jobKey).sort()).toEqual(['lint', 'test'])

    const states = await statesOf(runId)

    expect(states.lint).toBe('succeeded')
    expect(states.test).toBe('succeeded')

    /*
     * The barrier closed itself the moment both dependencies were in. It is the
     * control plane's own work, so no machine ever sees it - which is exactly
     * why the harness draining to empty is the right end condition rather than
     * a job count.
     */
    expect(states.ready).toBe('succeeded')

    // And the run is holding at the gate: not finished, and nothing claimable.
    expect(states.approve).toBe('paused')
    expect(states.deploy).toBe('blocked')
    expect(await runState(runId)).toBe('waiting')
  }, 120_000)

  test('and opening the gate lets the deploy through the same way', async () => {
    if (!available)
      return

    const runId = await start()

    await runner!.drain()

    const before = await statesOf(runId)

    expect(before.approve).toBe('paused')

    /*
     * The gate is opened by writing what an approval writes, and then settling
     * with the real settler.
     *
     * Who may open one, and what happens when the wrong person tries, is
     * `workflow-api.test.ts`'s subject and is tested against the endpoint
     * there. This file is about what the *graph* does once it opens, so the
     * decision is stipulated and everything after it is the production path.
     */
    const { settleRun } = await import('../../app/Actions/Workflow/settle')

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', approved_at: new Date().toISOString(), finished_at: new Date().toISOString() })
      .where('workflow_run_id', '=', runId)
      .where('job_id', '=', 'approve')
      .execute()

    await settleRun(runId)

    const after = await runner!.drain()

    expect(after.map(one => one.jobKey)).toEqual(['deploy'])
    expect((await statesOf(runId)).deploy).toBe('succeeded')
    expect(await runState(runId)).toBe('succeeded')
  }, 120_000)
})

describe('a pipeline that does not', () => {
  test('a failed half stops the barrier, and everything behind it', async () => {
    if (!available)
      return

    const runId = await start()

    await runner!.drain({ test: { state: 'failed', error: 'two assertions' } })

    const states = await statesOf(runId)

    expect(states.lint).toBe('succeeded')
    expect(states.test).toBe('failed')

    /*
     * The barrier is `skipped` rather than `failed`: it did not fail, it can
     * never run. The distinction is what lets a run reach a terminal state
     * instead of holding a pull request's checks open on a job waiting for a
     * dependency that will never arrive.
     */
    expect(states.ready).toBe('skipped')
    expect(states.approve).toBe('skipped')
    expect(states.deploy).toBe('skipped')

    // And nobody was ever asked to approve a deployment of a failing build,
    // which is the property the whole graph exists to have.
    expect(await runState(runId)).toBe('failed')
  }, 120_000)

  test('and a second drain has nothing to take, because a finished run is finished', async () => {
    if (!available)
      return

    const runId = await start()

    await runner!.drain({ lint: { state: 'failed' }, test: { state: 'failed' } })

    expect(await runState(runId)).toBe('failed')

    // The claim only offers work from a run that is going. A harness that kept
    // finding jobs here would be finding them in a run nobody should be
    // spending machines on.
    expect(await runner!.drain()).toEqual([])
  }, 120_000)
})
