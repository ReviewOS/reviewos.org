// Steps a job generates and adds to its own run.
//
// Buildkite's most important feature and its largest security surface, and both
// are true for the same reason: the file no longer says what the run will do. So
// most of this file is about what an upload is *not* allowed to do - raise its
// own trust level, outlive the run, or loop - because those are the properties
// that decide whether the feature can exist at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { splitLabels } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { MAX_UPLOADS_PER_RUN, uploadSteps } from '../../app/Actions/Workflow/upload'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null

const CI = `name: CI
on: push
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - run: ./generate
`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function runnerFacts(id: number) {
  const row: any = await db
    .selectFrom('runners')
    .select(['id', 'state', 'scope_type', 'scope_id', 'labels'])
    .where('id', '=', id)
    .executeTakeFirst()

  return {
    id: Number(row.id),
    state: String(row.state),
    scopeType: String(row.scope_type),
    scopeId: row.scope_id === null ? null : Number(row.scope_id),
    labels: splitLabels(row.labels),
  }
}

async function makeRunner(): Promise<any> {
  const row: any = await db
    .insertInto('runners')
    .values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(unique('tok')),
      labels: 'ubuntu-latest',
      state: 'active',
    })
    .returning(['id'])
    .executeTakeFirst()

  created.runnerIds.push(Number(row.id))

  return runnerFacts(Number(row.id))
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs', 'uploaded_by_job_id', 'upload_depth', 'priority', 'runs_on'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

/** A fresh run with everything older in this repository put to bed. */
async function freshRun(headSha: string): Promise<number> {
  const previous: any[] = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', created.repositoryId).execute()

  if (previous.length > 0) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('state', 'in', ['blocked', 'queued', 'running'])
      .where('workflow_run_id', 'in', previous.map((row: any) => Number(row.id)))
      .execute()
  }

  const result = await dispatchPush({ repositoryId: created.repositoryId, event: { ref: 'refs/heads/main' }, headSha })

  return result.created[0]!
}

/** Claim the run's first job, so there is something holding it that may upload. */
async function claimGenerator(): Promise<{ runId: number, jobId: number }> {
  const runId = await freshRun(`${Math.random().toString(16).slice(2, 10)}`.padEnd(40, '0'))
  const runner = await makeRunner()
  const claim = await claimNextJob(runner)

  return { runId, jobId: Number(claim!.jobId) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('upl')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Upload Test', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[workflow-uploads] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('a job generating steps', () => {
  test('adds them to its own run, attributed and queued', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()

    const outcome = await uploadSteps(jobId, `
shard-1:
  runs-on: ubuntu-latest
  steps:
    - run: ./test --shard 1
shard-2:
  runs-on: ubuntu-latest
  steps:
    - run: ./test --shard 2
`)

    expect(outcome.ok).toBe(true)
    expect(outcome.added).toHaveLength(2)

    const jobs = await jobsOf(runId)
    const uploaded = jobs.filter(job => job.uploaded_by_job_id)

    expect(uploaded.map(job => String(job.job_id)).sort()).toEqual(['shard-1', 'shard-2'])

    // Attributed to the job that made them: a run's graph is what it *became*,
    // and a screen showing only the original file would describe a run nobody
    // had.
    expect(uploaded.every(job => Number(job.uploaded_by_job_id) === jobId)).toBe(true)
    expect(uploaded.every(job => Number(job.upload_depth) === 1)).toBe(true)
    expect(uploaded.every(job => String(job.state) === 'queued')).toBe(true)
  }, 120_000)

  test('and may depend on jobs that were already in the run', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()

    const outcome = await uploadSteps(jobId, `
after:
  runs-on: ubuntu-latest
  needs: [generate]
  steps:
    - run: ./after
`)

    expect(outcome.ok).toBe(true)

    const after = (await jobsOf(runId)).find(job => String(job.job_id) === 'after')

    // Blocked, because the job that uploaded it has not finished - which is the
    // ordinary case: a generator usually wants its work to run after it.
    expect(String(after.state)).toBe('blocked')
  }, 120_000)

  test('a `needs:` naming nothing in the run is refused rather than waiting forever', async () => {
    if (!available)
      return

    const { jobId } = await claimGenerator()

    const outcome = await uploadSteps(jobId, `
orphan:
  runs-on: ubuntu-latest
  needs: [nothing-like-this]
  steps:
    - run: ./x
`)

    expect(outcome.ok).toBe(false)
    /*
     * Refused by the *parser*, with its own message and fix - because the
     * upload hands it the run's job names. A second check here would be a
     * second definition of what a valid graph is.
     */
    expect(String(outcome.problems?.join(' '))).toContain('nothing-like-this')
  }, 120_000)

  test('and a name the run already has is refused rather than merged', async () => {
    if (!available)
      return

    const { jobId } = await claimGenerator()

    /*
     * `needs:` is by name and two jobs sharing one is how a matrix is
     * expressed, so silently adding a second `generate` would change what
     * every existing `needs: generate` waits for - a graph nobody wrote.
     */
    const outcome = await uploadSteps(jobId, `
generate:
  runs-on: ubuntu-latest
  steps:
    - run: ./again
`)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('already has a job called')
  }, 120_000)
})

describe('what an upload may not do', () => {
  test('a document the parser refuses is refused here, with the same messages', async () => {
    if (!available)
      return

    const { jobId } = await claimGenerator()

    // A second, laxer validator for uploaded steps would be the one an
    // attacker reads.
    const outcome = await uploadSteps(jobId, `
broken:
  steps:
    - run: ./x
`)

    expect(outcome.ok).toBe(false)
    expect(String(outcome.problems?.join(' '))).toContain('does not say what it runs on')
  }, 120_000)

  test('it cannot give itself a priority the parent did not have', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()

    const outcome = await uploadSteps(jobId, `
jumper:
  runs-on: ubuntu-latest
  reviewos:
    priority: 900
  steps:
    - run: ./x
`)

    expect(outcome.ok).toBe(true)

    const jumper = (await jobsOf(runId)).find(job => String(job.job_id) === 'jumper')

    /*
     * Inherited, not read from the document. Priority is the one field where a
     * generated job could give itself something the parent did not have -
     * jumping a queue full of other people's work.
     */
    expect(Number(jumper.priority)).toBe(0)
  }, 120_000)

  test('a fork run stays untrusted, whatever it uploads', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()

    await db.updateTable('workflow_runs').set({ trusted: false } as any).where('id', '=', runId).execute()

    const outcome = await uploadSteps(jobId, `
sneaky:
  runs-on: ubuntu-latest
  steps:
    - run: ./x
`)

    expect(outcome.ok).toBe(true)

    const run: any = await db.selectFrom('workflow_runs').select(['trusted']).where('id', '=', runId).executeTakeFirst()

    /*
     * The uploaded document has no say in this at all - there is no field for
     * it and no code that reads one. A fork's run that could upload its way to
     * trusted would be the whole fork policy undone from inside a step.
     */
    expect(run.trusted).toBe(false)
  }, 120_000)

  test('a finished run takes nothing, however alive the machine still is', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()
    const runner = await runnerFacts(created.runnerIds[created.runnerIds.length - 1]!)

    await reportJob(runner, { jobId, state: 'succeeded' })

    const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()

    expect(String(run.state)).toBe('succeeded')

    const outcome = await uploadSteps(jobId, `
late:
  runs-on: ubuntu-latest
  steps:
    - run: ./x
`)

    /*
     * The runner may still be alive and a late upload will arrive; accepting
     * one would add work to a run whose conclusion has already been reported to
     * a branch protection rule.
     */
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('succeeded')
  }, 120_000)
})

describe('the budget', () => {
  test('bounds a loop by the control plane rather than by a quota nobody set', async () => {
    if (!available)
      return

    const { runId, jobId } = await claimGenerator()

    let refusal = ''

    // A generator that uploads a generator that uploads a generator: the depth
    // limit is what stops a run growing work forever from inside itself.
    for (let round = 0; round < MAX_UPLOADS_PER_RUN + 2; round++) {
      const outcome = await uploadSteps(jobId, `
round-${round}:
  runs-on: ubuntu-latest
  steps:
    - run: ./x
`)

      if (!outcome.ok) {
        refusal = outcome.reason
        break
      }
    }

    expect(refusal).toContain('already uploaded')

    const jobs = await jobsOf(runId)

    // Bounded, and everything it did add is still there and still valid - the
    // budget stops the next upload rather than unwinding the last one.
    expect(jobs.filter(job => job.uploaded_by_job_id).length).toBe(MAX_UPLOADS_PER_RUN)
  }, 180_000)

  test('and one upload cannot be enormous', async () => {
    if (!available)
      return

    const { jobId } = await claimGenerator()

    const many = Array.from({ length: 60 }, (_, index) => `job-${index}:\n  runs-on: ubuntu-latest\n  steps:\n    - run: ./x`).join('\n')

    const outcome = await uploadSteps(jobId, `\n${many}\n`)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('at most')
  }, 120_000)
})
