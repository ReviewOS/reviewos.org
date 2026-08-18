// A finished run is a record, not a view of the current file.
//
// Everything in this phase copies the definition onto the run at dispatch -
// jobs, steps, `fail-fast`, timeouts, the concurrency group - and the reason is
// one sentence: a run whose meaning changes when somebody edits a file is a run
// nobody can reconstruct. "It passed" has to keep meaning what it meant, and a
// re-run has to re-run what ran.
//
// The rule is easy to state and easy to break, because reading the newest
// version is always the shorter query. So this asks it of the real path: sync,
// dispatch, edit the file, register a new version, and check the finished run
// again.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const FIRST = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: make one
`

/** The same workflow, rewritten: a different job, a different command, a different limit. */
const SECOND = `name: CI
on: push
jobs:
  rebuilt:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - run: make two
`

async function sync(source: string, sha: string): Promise<void> {
  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path: '.github/workflows/ci.yml',
    source,
    sha,
  })
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'timeout_minutes', 'state'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('imm')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Immutable', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    available = true
  }
  catch (error) {
    console.warn(`[run-immutability] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a run that already happened', () => {
  test('keeps the jobs and the limits the file had when it started', async () => {
    if (!available)
      return

    await sync(FIRST, 'a'.repeat(40))

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b'.repeat(40),
    })

    const runId = Number(dispatched.created[0])

    expect(runId).toBeGreaterThan(0)

    const before = await jobsOf(runId)

    expect(before.map(job => String(job.job_id))).toEqual(['build'])
    expect(Number(before[0].timeout_minutes)).toBe(5)

    // The run finishes, and then somebody rewrites the workflow entirely.
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .execute()

    await db
      .updateTable('workflow_runs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('id', '=', runId)
      .execute()

    await sync(SECOND, 'c'.repeat(40))

    const after = await jobsOf(runId)

    /*
     * The point of the whole copy-on-dispatch design. Reading the newest
     * version is always the shorter query, and it would make this run say it
     * ran `rebuilt` with an hour's grace - a sentence nobody could check
     * against anything.
     */
    expect(after.map(job => String(job.job_id))).toEqual(['build'])
    expect(Number(after[0].timeout_minutes)).toBe(5)
  }, 120_000)

  test('and a new push runs the new definition, so the edit was not ignored either', async () => {
    if (!available)
      return

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'd'.repeat(40),
    })

    const jobs = await jobsOf(Number(dispatched.created[0]))

    // The other half of the rule, and the reason this is one test file rather
    // than an assertion: a definition that never changes is not immutability,
    // it is a cache nobody invalidates.
    expect(jobs.map(job => String(job.job_id))).toEqual(['rebuilt'])
    expect(Number(jobs[0].timeout_minutes)).toBe(60)
  }, 120_000)

  test('re-running it re-runs what ran, not what the file says now', async () => {
    if (!available)
      return

    const first: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'workflow_version_id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id')
      .executeTakeFirst()

    const { rerunRun } = await import('../../app/Actions/Workflow/rerun')

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'failed', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', Number(first.id))
      .execute()

    const outcome = await rerunRun({ runId: Number(first.id), scope: 'all' })

    expect(outcome.ok).toBe(true)

    const again = await jobsOf(Number(first.id))

    /*
     * A re-run of a run that went red is somebody asking "was it the code or
     * the machine". Re-running the *current* file answers a different question
     * and looks like the same one.
     */
    expect(again.map(job => String(job.job_id))).toEqual(['build'])
    expect(again.every(job => String(job.state) === 'queued' || String(job.state) === 'blocked')).toBe(true)
  }, 120_000)
})
