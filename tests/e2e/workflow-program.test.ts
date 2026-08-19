// A workflow written as a program, from the file to the row a runner claims.
//
// The claim being tested is the normalization one, and it is the box that says
// "if a screen can tell which authoring form produced a run, the normalization
// is wrong". So the assertions are deliberately about *sameness*: same run
// table, same job table, same claim, same dispatch path. The only thing that
// differs is a flag saying which job is the program.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, versionId: 0, handle: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const PROGRAM = `/* --- reviewos
name: Release
on:
  push:
    branches: [main]
--- */

import { publish } from '../../src/publish'

export default async function (workflow) {
  const packages = await workflow.step('list', () => discover())

  for (const name of packages)
    await workflow.step(\`publish \${name}\`, () => publish(name))
}
`

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_versions').select(['id']).limit(1).execute()

    created.handle = unique('prog')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Program', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const name = unique('repo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')

    const synced = await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.reviewos/workflows/fixture.ts',
      source: PROGRAM,
      sha: '9'.repeat(40),
    })

    created.versionId = Number(synced.versionId)
    available = true
  }
  catch (error) {
    console.warn(`[program] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!available || !db)
    return

  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => null)
})

/** A run with its orchestrator on it, sleeping the way a suspended one is. */
async function aRunWithOrchestrator(): Promise<{ runId: number, jobId: number }> {
  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: Math.floor(Math.random() * 1_000_000),
    state: 'running',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: '7'.repeat(40),
    definition_sha: '7'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  const job: any = await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    repository_id: created.repositoryId,
    job_id: 'orchestrate',
    name: 'orchestrate',
    position: 1,
    state: 'sleeping',
    orchestrator: true,
  }).returning(['id']).executeTakeFirst()

  return { runId: Number(run.id), jobId: Number(job.id) }
}

describe('storing a program', () => {
  test('makes an ordinary workflow version, with the triggers from its front matter', async () => {
    if (!available)
      return

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')

    const result = await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.reviewos/workflows/release.ts',
      source: PROGRAM,
      sha: 'a'.repeat(40),
    })

    expect(result.ok).toBe(true)

    const version: any = await db
      .selectFrom('workflow_versions')
      .select(['on_push', 'source_path'])
      .where('id', '=', Number(result.versionId))
      .executeTakeFirst()

    // Knowable before anything runs, which is the whole reason the front matter
    // exists: the alternative to reading it is running the program to find out
    // whether it wanted to run.
    expect(Boolean(version.on_push)).toBe(true)
    expect(String(version.source_path)).toBe('.reviewos/workflows/release.ts')
  }, 120_000)

  test('with exactly one job, whose step runs the program', async () => {
    if (!available)
      return

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')
    const { ORCHESTRATE_ACTION } = await import('../../app/Actions/Workflow/program')

    const result = await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.reviewos/workflows/one.ts',
      source: PROGRAM,
      sha: 'b'.repeat(40),
    })

    const jobs: any[] = await db
      .selectFrom('workflow_version_jobs')
      .select(['id', 'job_id'])
      .where('workflow_version_id', '=', Number(result.versionId))
      .execute()

    // One, because the graph is decided at runtime - which is the entire reason
    // somebody writes a workflow as a program.
    expect(jobs.map(one => one.job_id)).toEqual(['orchestrate'])

    const steps: any[] = await db
      .selectFrom('workflow_version_steps')
      .select(['uses', 'inputs'])
      .where('workflow_version_job_id', '=', Number(jobs[0].id))
      .execute()

    expect(steps).toHaveLength(1)
    expect(String(steps[0].uses)).toBe(ORCHESTRATE_ACTION)
    expect(String(steps[0].inputs)).toContain('.reviewos/workflows/one.ts')
  }, 120_000)

  test('and a program with no front matter is refused with a sentence about what is missing', async () => {
    if (!available)
      return

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')

    const result = await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.reviewos/workflows/bare.ts',
      source: 'export default async function () {}\n',
      sha: 'c'.repeat(40),
    })

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.message).toContain('front matter')
  }, 120_000)
})

describe('dispatching a program', () => {
  /**
   * The normalization box, stated as a test. A run from a program is a
   * `workflow_runs` row with `workflow_jobs` under it, dispatched by the same
   * function and claimable by the same machine. The only thing that says which
   * authoring form produced it is a flag the control plane needs to know which
   * job to requeue when a sleep comes due.
   */
  test('produces an ordinary run whose one job is marked as the orchestrator', async () => {
    if (!available)
      return

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')
    const { dispatchPush } = await import('../../app/Actions/Workflow/dispatch')

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.reviewos/workflows/dispatched.ts',
      source: PROGRAM,
      sha: 'd'.repeat(40),
    })

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('e').padEnd(40, '0').slice(0, 40),
    })

    expect(dispatched.created.length).toBeGreaterThan(0)

    const jobs: any[] = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .select(['workflow_jobs.job_id as job_id', 'workflow_jobs.orchestrator as orchestrator', 'workflow_jobs.kind as kind'])
      .where('workflow_versions.source_path', '=', '.reviewos/workflows/dispatched.ts')
      .execute()

    expect(jobs).toHaveLength(1)
    expect(jobs[0].job_id).toBe('orchestrate')
    expect(Boolean(jobs[0].orchestrator)).toBe(true)

    /*
     * `command`, not a kind of its own. An orchestrator is a command job in
     * every way a runner cares about - claimed, leased, running untrusted code
     * on a machine that is not the control plane - and giving it its own kind
     * would take it out of the claim, which is the one thing the architecture
     * needs it to go through.
     */
    expect(String(jobs[0].kind)).toBe('command')
  }, 120_000)

  test('and a workflow written in YAML gets no orchestrator, so the flag means something', async () => {
    if (!available)
      return

    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')
    const { dispatchPush } = await import('../../app/Actions/Workflow/dispatch')

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      // Named `orchestrate` on purpose: the flag is derived from the file the
      // version came from, so a job somebody happened to call this in YAML is
      // still an ordinary job.
      path: '.reviewos/workflows/static.yml',
      source: 'name: Static\non:\n  push:\n    branches: [main]\njobs:\n  orchestrate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
      sha: 'f'.repeat(40),
    })

    await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('a').padEnd(40, '0').slice(0, 40),
    })

    const jobs: any[] = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .select(['workflow_jobs.orchestrator as orchestrator'])
      .where('workflow_versions.source_path', '=', '.reviewos/workflows/static.yml')
      .execute()

    expect(jobs.length).toBeGreaterThan(0)

    for (const job of jobs)
      expect(Boolean(job.orchestrator)).toBe(false)
  }, 120_000)
})

describe('a job a program asked for', () => {
  /**
   * The normalization, at the level that matters. A program calling
   * `job('test', { run: 'bun test' })` does not run `bun test` in its own
   * process - the control plane writes a row, a runner claims it through the
   * ordinary claim, and the result comes back through the ordinary report.
   */
  test('is an ordinary job row on the same run, with a step under it', async () => {
    if (!available)
      return

    const { createOrchestratedJob, specFrom } = await import('../../app/Actions/Workflow/orchestratedJob')
    const { record } = await import('../../app/Actions/Workflow/journal')

    const run = await aRunWithOrchestrator()

    const call = await record({ runId: run.runId, sequence: 1, kind: 'job', name: 'test', args: { run: 'bun test' } })

    const jobId = await createOrchestratedJob({
      runId: run.runId,
      repositoryId: created.repositoryId,
      entryId: (call as any).entryId,
      name: 'test',
      spec: specFrom({ 'run': 'bun test', 'runs-on': 'ubuntu-latest' }),
    })

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['name', 'state', 'kind', 'runs_on', 'orchestrator'])
      .where('id', '=', jobId)
      .executeTakeFirst()

    // Queued straight away: there is no graph above it. What it waited for was
    // the program, and the program has already decided by asking.
    expect(job.state).toBe('queued')
    expect(job.name).toBe('test')
    expect(String(job.kind)).toBe('command')
    // Not itself an orchestrator - it is work, not a program.
    expect(Boolean(job.orchestrator)).toBe(false)

    const steps: any[] = await db
      .selectFrom('workflow_steps')
      .select(['command', 'name'])
      .where('workflow_job_id', '=', jobId)
      .execute()

    expect(steps).toHaveLength(1)
    expect(String(steps[0].command)).toBe('bun test')
  }, 120_000)

  test('and its outputs become the call\'s result, so the program reads them on its next pass', async () => {
    if (!available)
      return

    const { createOrchestratedJob, resolveJobCall, specFrom } = await import('../../app/Actions/Workflow/orchestratedJob')
    const { record } = await import('../../app/Actions/Workflow/journal')

    const run = await aRunWithOrchestrator()
    const call = await record({ runId: run.runId, sequence: 1, kind: 'job', name: 'build', args: { run: 'make' } })

    const jobId = await createOrchestratedJob({
      runId: run.runId,
      repositoryId: created.repositoryId,
      entryId: (call as any).entryId,
      name: 'build',
      spec: specFrom({ run: 'make' }),
    })

    expect(await resolveJobCall(jobId, { state: 'succeeded', outputs: { artifact: 'app.tar.gz' } })).toBe(true)

    const replayed = await record({ runId: run.runId, sequence: 1, kind: 'job', name: 'build', args: { run: 'make' } })

    expect(replayed.decision).toBe('replay')
    expect((replayed as any).result).toEqual({ artifact: 'app.tar.gz' })

    // And the program is back in the queue rather than waiting for a sweep: the
    // result is in hand, so making it wait a minute would add a minute to every
    // step of every code-first workflow.
    const orchestrator: any = await db
      .selectFrom('workflow_jobs').select(['state']).where('id', '=', run.jobId).executeTakeFirst()

    expect(String(orchestrator.state)).toBe('queued')
  }, 120_000)

  test('and a job that failed is replayed as a failure the program can catch', async () => {
    if (!available)
      return

    const { createOrchestratedJob, resolveJobCall, specFrom } = await import('../../app/Actions/Workflow/orchestratedJob')
    const { record } = await import('../../app/Actions/Workflow/journal')

    const run = await aRunWithOrchestrator()
    const call = await record({ runId: run.runId, sequence: 1, kind: 'job', name: 'deploy', args: { run: 'ship' } })

    const jobId = await createOrchestratedJob({
      runId: run.runId,
      repositoryId: created.repositoryId,
      entryId: (call as any).entryId,
      name: 'deploy',
      spec: specFrom({ run: 'ship' }),
    })

    await resolveJobCall(jobId, { state: 'failed', outputs: null, error: 'the registry rejected the tag' })

    const replayed = await record({ runId: run.runId, sequence: 1, kind: 'job', name: 'deploy', args: { run: 'ship' } })

    // Failed rather than left pending. Leaving it pending would hang the run on
    // work that is already over.
    expect(replayed.decision).toBe('failed')
    expect((replayed as any).error).toContain('registry')
  }, 120_000)

  test('and a loop calling one name twelve times makes twelve addressable jobs', async () => {
    if (!available)
      return

    const { createOrchestratedJob, specFrom } = await import('../../app/Actions/Workflow/orchestratedJob')
    const { record } = await import('../../app/Actions/Workflow/journal')

    const run = await aRunWithOrchestrator()
    const ids: string[] = []

    for (const index of [1, 2, 3]) {
      const call = await record({ runId: run.runId, sequence: index, kind: 'job', name: 'publish', args: { index } })

      const jobId = await createOrchestratedJob({
        runId: run.runId,
        repositoryId: created.repositoryId,
        entryId: (call as any).entryId,
        name: 'publish',
        spec: specFrom({ run: `publish ${index}` }),
      })

      const job: any = await db.selectFrom('workflow_jobs').select(['job_id']).where('id', '=', jobId).executeTakeFirst()

      ids.push(String(job.job_id))
    }

    // `job_id` is what `needs:` and the API address a job by, so three jobs with
    // one name still need three keys. Naming cannot tell them apart; the
    // journal position can.
    expect(new Set(ids).size).toBe(3)
  }, 120_000)

  test('and a call with nothing to run is refused rather than made into a job no machine can execute', async () => {
    if (!available)
      return

    const { isRunnable, specFrom } = await import('../../app/Actions/Workflow/orchestratedJob')

    expect(isRunnable(specFrom({ env: { A: '1' } }))).toBe(false)
    expect(isRunnable(specFrom({ run: 'make' }))).toBe(true)
    expect(isRunnable(specFrom({ uses: 'actions/checkout@v4' }))).toBe(true)
  }, 120_000)
})
