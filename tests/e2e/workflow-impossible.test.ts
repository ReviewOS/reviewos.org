// A job nothing on this instance could ever take.
//
// The distinction every test here is about: a capability nobody has is not the
// same as a fleet that is busy. Failing the first is telling somebody the truth;
// failing the second is the instance giving up on work it can do.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { failImpossibleJobs } from '../../app/Actions/Workflow/impossible'
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

/** One job for a machine this instance has, one for a machine it does not. */
const MIXED = `name: Mixed
on: push
jobs:
  linux:
    runs-on: ubuntu-latest
    steps:
      - run: make
  mac:
    runs-on: macos-14
    steps:
      - run: make mac
`

async function statesOf(runId: number): Promise<Record<string, { state: string, reason: string }>> {
  const rows = await db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state', 'condition_reason'])
    .where('workflow_run_id', '=', runId)
    .execute()

  return Object.fromEntries(rows.map((row: any) => [
    String(row.job_id),
    { state: String(row.state), reason: String(row.condition_reason ?? '') },
  ]))
}

/** A run whose jobs have been queued longer than the grace period. */
async function agedRun(): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  const runId = Number(result.created[0])

  /*
   * Moved into the past rather than waited for. The grace period is an hour,
   * and it exists because "nothing answers to this label" is also what a
   * correct instance looks like in the minute between a workflow landing and
   * an operator registering the runner for it.
   */
  await db
    .updateTable('workflow_jobs')
    .set({ queued_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })
    .where('workflow_run_id', '=', runId)
    .execute()

  return runId
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('imp')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Impossible', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
      path: '.github/workflows/mixed.yml',
      source: MIXED,
      sha: 'a'.repeat(40),
    })

    // A machine that answers to one of the two labels, so the sweep has a fleet
    // to reason about rather than an empty instance.
    runner = await fakeRunner({ db, labels: ['ubuntu-latest'] })

    available = true
  }
  catch (error) {
    console.warn(`[impossible] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('a label no runner carries', () => {
  test('fails the job with the reason and what to do about it', async () => {
    if (!available)
      return

    const runId = await agedRun()
    const outcome = await failImpossibleJobs()

    expect(outcome.failed).toBeGreaterThan(0)

    const states = await statesOf(runId)

    expect(states.mac.state).toBe('failed')
    // The summary and the fix together: "no runner has macos-14" without "the
    // ones that could take this have ubuntu-latest" is half an answer.
    expect(states.mac.reason).toContain('macos-14')
    expect(states.mac.reason.length).toBeGreaterThan(40)
  }, 120_000)

  test('and leaves the job a machine could take alone', async () => {
    if (!available)
      return

    /*
     * The half that matters most. A sweep that failed both would be an instance
     * cancelling work it is perfectly able to do, and the run would go red on a
     * job that was about to succeed.
     */
    const runId = await agedRun()

    await failImpossibleJobs()

    const states = await statesOf(runId)

    expect(states.linux.state).toBe('queued')
    expect(states.mac.state).toBe('failed')

    // And the one that can run still does.
    const done = await runner!.drain()

    expect(done.some(one => one.jobKey === 'linux')).toBe(true)
  }, 120_000)
})

describe('what the sweep will not touch', () => {
  test('a job that has not waited out the grace period', async () => {
    if (!available)
      return

    /*
     * The minute after a workflow lands, before anybody has registered the
     * runner it asks for, looks exactly like an impossible job. Failing it
     * would make the fix - register the machine - arrive too late to help.
     */
    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('c').padEnd(40, '0').slice(0, 40),
    })

    const runId = Number(result.created[0])

    await failImpossibleJobs()

    expect((await statesOf(runId)).mac.state).toBe('queued')
  }, 120_000)

  test('and a job whose machines are merely busy', async () => {
    if (!available)
      return

    const runId = await agedRun()

    // The runner that answers `ubuntu-latest` takes work elsewhere; the label
    // still exists on the fleet, so the job is waiting rather than stuck.
    await db
      .updateTable('runners')
      .set({ state: 'active' })
      .where('id', '=', runner!.runnerId)
      .execute()

    await failImpossibleJobs()

    expect((await statesOf(runId)).linux.state).toBe('queued')
  }, 120_000)
})
