// The step kinds against the real tables: a barrier, a gate, and a trigger.
//
// The unit tests say the parser reads them. This says the *engine* does the
// three things that make them worth having, and each one is a claim a test can
// falsify: nothing that is not a command job is ever handed to a runner, a gate
// holds the run until a person opens it and their answers become the job's
// outputs, and a trigger starts a second run without spending a machine to do
// it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { splitLabels } from '../../app/Actions/Runner/protocol'
import { reportJob } from '../../app/Actions/Runner/report'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/*
 * One pipeline with all four kinds in it, in the order somebody would write
 * them: build, wait for everything, ask a person, deploy, tell the other
 * workflow.
 */
const SHIP = `name: Ship
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps:
      - run: make
  test:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps:
      - run: make test
  everything-built:
    reviewos:
      wait: true
  approve:
    reviewos:
      block:
        prompt: Deploy to production?
        fields:
          - key: version
            type: string
            required: true
          - key: where
            type: select
            options: [staging, production]
  deploy:
    runs-on: ubuntu-latest
    needs: [approve]
    steps:
      - run: ./deploy
  announce:
    needs: [deploy]
    reviewos:
      trigger: Announce
`

/** The workflow the trigger starts, which has to exist for it to resolve. */
const ANNOUNCE = `name: Announce
on: workflow_dispatch
jobs:
  say:
    runs-on: ubuntu-latest
    steps:
      - run: echo shipped
`

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
    .select(['id', 'job_id', 'state', 'kind', 'settings', 'group_label', 'outputs', 'approved_by_id', 'triggered_run_id', 'condition_reason', 'attempt'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

function jobNamed(rows: any[], key: string): any {
  return rows.find(row => String(row.job_id) === key)
}

async function runState(runId: number): Promise<string> {
  const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? '')
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('stp')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Step Model', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the step model end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    for (const [path, source] of [['.github/workflows/announce.yml', ANNOUNCE], ['.github/workflows/ship.yml', SHIP]]) {
      await syncWorkflowFile({
        repositoryId: created.repositoryId,
        ownerType: 'user',
        ownerId: created.ownerId,
        path: String(path),
        source: String(source),
        sha: 'a'.repeat(40),
      })
    }

    available = true
  }
  catch (error) {
    console.warn(`[step-model] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('a pipeline with all four kinds', () => {
  let runId = 0

  test('starts with the barrier and the gate blocked, and the commands queued', async () => {
    if (!available)
      return

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b'.repeat(40),
    })

    // Two workflows exist; the one under test is the one with the gate in it.
    for (const candidate of result.created) {
      const rows = await jobsOf(candidate)

      if (jobNamed(rows, 'approve'))
        runId = candidate
    }

    expect(runId).toBeGreaterThan(0)

    const rows = await jobsOf(runId)

    expect(jobNamed(rows, 'build').state).toBe('queued')
    expect(jobNamed(rows, 'test').state).toBe('queued')
    expect(jobNamed(rows, 'everything-built').kind).toBe('wait')
    expect(jobNamed(rows, 'everything-built').state).toBe('blocked')
    expect(jobNamed(rows, 'approve').kind).toBe('block')

    // The group label travels onto the run, so the screen can print it once.
    expect(jobNamed(rows, 'build').group_label).toBe('Build')
  }, 60_000)

  test('a runner is never offered anything but a command job', async () => {
    if (!available)
      return

    const runner = await makeRunner()
    const taken: string[] = []

    for (let poll = 0; poll < 6; poll++) {
      const claim = await claimNextJob(runner)

      if (!claim)
        break

      taken.push(claim.jobKey)
      await reportJob(runner, { jobId: claim.jobId, state: 'succeeded' })
    }

    /*
     * The claim's whole rule in one assertion: a barrier, a gate and a trigger
     * are the control plane's own work, and a runner deciding a deployment
     * approval would not be a scheduling mistake - it would be the gate not
     * existing.
     */
    expect(taken).toContain('build')
    expect(taken).toContain('test')
    expect(taken).not.toContain('everything-built')
    expect(taken).not.toContain('approve')
    expect(taken).not.toContain('announce')
  }, 120_000)

  test('the barrier satisfies itself once everything before it is done', async () => {
    if (!available)
      return

    const rows = await jobsOf(runId)

    expect(jobNamed(rows, 'everything-built').state).toBe('succeeded')
  }, 60_000)

  test('and the gate is waiting for a person, which the run says out loud', async () => {
    if (!available)
      return

    const rows = await jobsOf(runId)

    expect(jobNamed(rows, 'approve').state).toBe('paused')

    /*
     * `waiting`, not `running`. The difference is who it is waiting for: a
     * spinner on a run that needs a person is the one case where the delay is
     * not the instance's fault, and a screen that cannot say so sends somebody
     * looking at the runners.
     */
    expect(await runState(runId)).toBe('waiting')

    // And nothing downstream of it has moved.
    expect(jobNamed(rows, 'deploy').state).toBe('blocked')
  }, 60_000)

  test('opening the gate records who, and turns the answers into outputs', async () => {
    if (!available)
      return

    const gate = jobNamed(await jobsOf(runId), 'approve')

    /*
     * Written the way the action writes it, because the action itself is
     * covered by the API test - what this is checking is the *engine* half:
     * that a gate opening moves the graph exactly as a finished job does.
     */
    await db
      .updateTable('workflow_jobs')
      .set({
        state: 'succeeded',
        approved_by_id: created.ownerId,
        approved_at: new Date().toISOString(),
        outputs: JSON.stringify({ version: '1.2.3', where: 'production' }),
      } as any)
      .where('id', '=', Number(gate.id))
      .execute()

    await settleRun(runId)

    const rows = await jobsOf(runId)

    expect(Number(jobNamed(rows, 'approve').approved_by_id)).toBe(created.ownerId)

    // The typed values are the job's outputs, so a later job reads them the
    // same way it reads any other job's.
    expect(JSON.parse(String(jobNamed(rows, 'approve').outputs))).toEqual({ version: '1.2.3', where: 'production' })

    // And the run is moving again.
    expect(jobNamed(rows, 'deploy').state).toBe('queued')
  }, 60_000)

  test('the trigger starts a second run without spending a machine', async () => {
    if (!available)
      return

    const runner = await makeRunner()
    const claim = await claimNextJob(runner)

    expect(claim!.jobKey).toBe('deploy')

    await reportJob(runner, { jobId: claim!.jobId, state: 'succeeded' })

    const announce = jobNamed(await jobsOf(runId), 'announce')

    expect(announce.state).toBe('succeeded')
    expect(Number(announce.triggered_run_id)).toBeGreaterThan(0)

    const started: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'event', 'state', 'trigger_depth', 'trusted'])
      .where('id', '=', Number(announce.triggered_run_id))
      .executeTakeFirst()

    // Its own event name: a triggered run was not started by a person pressing
    // a button, and saying it was sends somebody looking for whoever did.
    expect(String(started.event)).toBe('workflow_trigger')
    expect(Number(started.trigger_depth)).toBe(1)

    // The started run has real work in it.
    const startedJobs = await jobsOf(Number(started.id))

    expect(startedJobs.map(job => String(job.job_id))).toEqual(['say'])
    expect(startedJobs[0]!.state).toBe('queued')

    // And the run that triggered it is finished, because a trigger does not
    // wait unless it was told to.
    expect(await runState(runId)).toBe('succeeded')
  }, 120_000)
})

describe('a trigger that cannot resolve', () => {
  test('fails with a reason rather than passing quietly', async () => {
    if (!available)
      return

    /*
     * The failure this kind is most dangerous for: a pipeline whose deploy
     * stage silently did nothing, and a green run to go with it.
     */
    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 900,
      state: 'queued',
      event: 'push',
      event_ref: 'refs/heads/ghost',
      head_sha: 'c'.repeat(40),
      definition_sha: 'c'.repeat(40),
      trusted: true,
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'ghost',
      name: 'Ghost',
      position: 0,
      state: 'blocked',
      kind: 'trigger',
      settings: JSON.stringify({ workflow: 'nothing-like-this.yml', inputs: {}, await: false }),
    }).execute()

    await settleRun(Number(run.id))

    const job = jobNamed(await jobsOf(Number(run.id)), 'ghost')

    expect(job.state).toBe('failed')
    expect(String(job.condition_reason)).toContain('nothing-like-this.yml')
    expect(await runState(Number(run.id))).toBe('failed')
  }, 60_000)
})

/*
 * The monorepository case, which is the one that decides whether a big
 * repository is usable here at all: the workflow runs on every push, and what
 * it *runs* depends on what moved.
 */
describe('if-changed', () => {
  const MONOREPO = `name: Monorepo
on: push
jobs:
  api:
    runs-on: ubuntu-latest
    reviewos:
      if-changed: packages/api/**
    steps:
      - run: make api
  web:
    runs-on: ubuntu-latest
    reviewos:
      if-changed: packages/web/**
    steps:
      - run: make web
  always:
    runs-on: ubuntu-latest
    steps:
      - run: make lint
`

  async function runWith(changed: string[], sha: string): Promise<any[]> {
    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/monorepo.yml',
      source: MONOREPO,
      sha: 'f'.repeat(40),
    })

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main', changed },
      headSha: sha,
    })

    for (const candidate of result.created) {
      const rows = await jobsOf(candidate)

      if (jobNamed(rows, 'api'))
        return rows
    }

    return []
  }

  test('a push into one package runs that package and skips the others', async () => {
    if (!available)
      return

    const rows = await runWith(['packages/api/src/index.ts', 'packages/api/README.md'], '1a'.repeat(20))

    expect(jobNamed(rows, 'api').state).toBe('queued')
    expect(jobNamed(rows, 'web').state).toBe('skipped')

    // A job that named no globs is a job that always runs.
    expect(jobNamed(rows, 'always').state).toBe('queued')

    /*
     * And the reason is on the row. The whole value of skipping a job in a
     * monorepository is being able to see why without opening the file.
     */
    expect(String(jobNamed(rows, 'web').condition_reason)).toContain('packages/web/**')
  }, 60_000)

  test('and a push whose paths are unknown runs everything', async () => {
    if (!available)
      return

    /*
     * Empty means *unknown* rather than "nothing changed" - a force push, a
     * first push, a rewrite past the ceiling. The two failures are not equal:
     * a job that runs when it need not have costs a few machine-minutes, and a
     * job skipped when it should have run is a broken commit nobody noticed.
     */
    const rows = await runWith([], '1b'.repeat(20))

    expect(jobNamed(rows, 'api').state).toBe('queued')
    expect(jobNamed(rows, 'web').state).toBe('queued')
  }, 60_000)
})

/*
 * Retry: the feature every CI system grows, and the one that has to be bounded
 * from the first line. A retry with no cap is a job that fails forever on
 * somebody else's machine.
 */
describe('retry', () => {
  async function retryingRun(sha: string, settings: Record<string, unknown>): Promise<{ runId: number, jobId: number }> {
    /*
     * Everything else in this repository is put to bed first.
     *
     * A repository-scoped runner takes the oldest claimable job, so without
     * this each test would be reporting against whatever an earlier one left
     * queued - which is a test of nothing, and the kind of order-dependence
     * that passes alone and fails in a suite.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('state', 'in', ['blocked', 'queued', 'running', 'paused'])
      .where('workflow_run_id', 'in', (
        await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', created.repositoryId).execute()
      ).map((row: any) => Number(row.id)))
      .execute()

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 700 + Math.floor(Number(`0x${sha.slice(0, 4)}`) % 200),
      state: 'queued',
      event: 'push',
      event_ref: `refs/heads/retry-${sha.slice(0, 6)}`,
      head_sha: sha,
      definition_sha: sha,
      trusted: true,
    }).returning(['id']).executeTakeFirst()

    const job: any = await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'flaky',
      name: 'Flaky',
      position: 0,
      state: 'queued',
      runs_on: 'ubuntu-latest',
      settings: JSON.stringify(settings),
    }).returning(['id']).executeTakeFirst()

    return { runId: Number(run.id), jobId: Number(job.id) }
  }

  test('a failure goes back to the queue while attempts remain, and fails when they run out', async () => {
    if (!available)
      return

    const { runId } = await retryingRun('2a'.repeat(20), { retry: { attempts: 2, exitStatus: [] } })
    const runner = await makeRunner()

    // First failure: requeued, with the attempt counted and the reason on the row.
    const first = await claimNextJob(runner)
    await reportJob(runner, { jobId: first!.jobId, state: 'failed', error: 'flaked', exitStatus: 1 })

    let job = jobNamed(await jobsOf(runId), 'flaky')

    expect(job.state).toBe('queued')
    expect(Number(job.attempt)).toBe(2)
    expect(String(job.condition_reason)).toContain('retrying')

    // Second failure: one attempt left, so still requeued.
    const second = await claimNextJob(runner)
    await reportJob(runner, { jobId: second!.jobId, state: 'failed', error: 'flaked again', exitStatus: 1 })

    job = jobNamed(await jobsOf(runId), 'flaky')

    expect(job.state).toBe('queued')
    expect(Number(job.attempt)).toBe(3)

    // Third: out of attempts, so it is an ordinary failure. A job that fails
    // three times is not flaky, it is broken.
    const third = await claimNextJob(runner)
    await reportJob(runner, { jobId: third!.jobId, state: 'failed', error: 'still broken', exitStatus: 1 })

    job = jobNamed(await jobsOf(runId), 'flaky')

    expect(job.state).toBe('failed')
    expect(Number(job.attempt)).toBe(3)
  }, 120_000)

  test('and a workflow that named exit statuses retries only those', async () => {
    if (!available)
      return

    /*
     * The distinction the key exists for: a suite that exits 1 on a failed
     * assertion is not worth running again, and a step killed for memory at
     * 137 is exactly what a retry is for.
     */
    const { runId } = await retryingRun('2b'.repeat(20), { retry: { attempts: 2, exitStatus: [137] } })
    const runner = await makeRunner()

    const claim = await claimNextJob(runner)
    await reportJob(runner, { jobId: claim!.jobId, state: 'failed', error: 'assertion failed', exitStatus: 1 })

    const job = jobNamed(await jobsOf(runId), 'flaky')

    expect(job.state).toBe('failed')
    expect(Number(job.attempt)).toBe(1)
  }, 120_000)

  test('a job with no retry: fails the first time, as it always did', async () => {
    if (!available)
      return

    const { runId } = await retryingRun('2c'.repeat(20), {})
    const runner = await makeRunner()

    const claim = await claimNextJob(runner)
    await reportJob(runner, { jobId: claim!.jobId, state: 'failed', error: 'broken', exitStatus: 1 })

    expect(jobNamed(await jobsOf(runId), 'flaky').state).toBe('failed')
  }, 120_000)
})

/*
 * The three step attributes against the real tables.
 *
 * The unit tests hold the rules; this holds where each one is applied, which is
 * the part that only the engine can be wrong about: `skip` and `branches` at
 * dispatch, `soft-fail` at the report.
 */
describe('step attributes', () => {
  const ATTRIBUTES = `name: Attributes
on: push
jobs:
  always:
    runs-on: ubuntu-latest
    steps:
      - run: ./always
  only-main:
    runs-on: ubuntu-latest
    reviewos:
      branches: [main]
    steps:
      - run: ./deploy
  never-here:
    runs-on: ubuntu-latest
    reviewos:
      branches: ['!main']
    steps:
      - run: ./preview
  turned-off:
    runs-on: ubuntu-latest
    reviewos:
      skip: The vendor API is down until Tuesday.
    steps:
      - run: ./vendor
  lint:
    runs-on: ubuntu-latest
    reviewos:
      soft-fail: [1]
    steps:
      - run: ./lint
`

  let runId = 0

  test('skip and branches decide when the run is created', async () => {
    if (!available)
      return

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/attributes.yml',
      source: ATTRIBUTES,
      sha: 'c'.repeat(40),
    })

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('e').padEnd(40, '0').slice(0, 40),
    })

    for (const candidate of result.created) {
      const rows = await jobsOf(candidate)

      if (jobNamed(rows, 'turned-off'))
        runId = candidate
    }

    expect(runId).toBeGreaterThan(0)

    const rows = await jobsOf(runId)

    // A branch the job names: queued, like any other.
    expect(String(jobNamed(rows, 'only-main').state)).toBe('queued')

    /*
     * The two that will never run are `skipped` from the first second, with
     * the reason on them - rather than sitting in the queue looking like work
     * nobody has got to, which is how somebody ends up investigating a runner.
     */
    const excluded = jobNamed(rows, 'never-here')

    expect(String(excluded.state)).toBe('skipped')
    expect(String(excluded.condition_reason)).toContain('excluded')

    const off = jobNamed(rows, 'turned-off')

    expect(String(off.state)).toBe('skipped')
    expect(String(off.condition_reason)).toBe('The vendor API is down until Tuesday.')
  }, 120_000)

  test('and soft-fail decides at the report, keeping the failure visible', async () => {
    if (!available)
      return

    const runner = await makeRunner()
    const rows = await jobsOf(runId)
    const lint = jobNamed(rows, 'lint')

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', runner_id: String(runner.id), lease_expires_at: new Date(Date.now() + 60_000).toISOString() } as any)
      .where('id', '=', Number(lint.id))
      .execute()

    const jobToken: any = await db
      .selectFrom('workflow_jobs')
      .select(['job_token_hash'])
      .where('id', '=', Number(lint.id))
      .executeTakeFirst()

    expect(jobToken).toBeTruthy()

    await reportJob(runner, { jobId: Number(lint.id), state: 'failed', error: 'findings', exitStatus: 1 })

    const after = jobNamed(await jobsOf(runId), 'lint')

    /*
     * The job still says it failed - a screen that showed a tolerated failure
     * as passing is one where nobody finds out the linter has been failing for
     * a month - and the graph is told not to count it.
     */
    expect(String(after.state)).toBe('failed')
    expect(String(after.condition_reason)).toContain('tolerates')

    const row: any = await db
      .selectFrom('workflow_jobs')
      .select(['continue_on_error'])
      .where('id', '=', Number(lint.id))
      .executeTakeFirst()

    expect(row.continue_on_error).toBe(true)
  }, 120_000)
})

/*
 * `allow-dependency-failure`, in the graph.
 *
 * The unit test says the parser reads it and that it reaches the graph as the
 * same flag a barrier's `continue-on-failure` sets. This says the settler acts
 * on it: the job runs after a failed dependency, and the jobs that did *not*
 * ask are skipped as they always were.
 */
describe('parallelism', () => {
  const SHARDED = `name: Sharded
on: push
jobs:
  suite:
    runs-on: ubuntu-latest
    reviewos:
      parallelism: 5
    steps:
      - run: ./test --shard $REVIEWOS_PARALLEL_JOB/$REVIEWOS_PARALLEL_JOB_COUNT
  once:
    runs-on: ubuntu-latest
    steps:
      - run: ./build
`

  test('one job in the file is five jobs in the run, each knowing which it is', async () => {
    if (!available)
      return

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/sharded.yml',
      source: SHARDED,
      sha: 'f'.repeat(40),
    })

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('p').padEnd(40, '0').slice(0, 40),
    })

    let rows: any[] = []

    for (const candidate of result.created) {
      const found = await db
        .selectFrom('workflow_jobs')
        .select(['job_id', 'name', 'state', 'parallel_index', 'parallel_total'])
        .where('workflow_run_id', '=', candidate)
        .orderBy('position')
        .execute()

      if (found.some((row: any) => String(row.job_id) === 'suite'))
        rows = found
    }

    const shards = rows.filter((row: any) => String(row.job_id) === 'suite')

    // Five rows, not one job that somehow ran five times: they go to five
    // machines and they fail separately, which is the whole reason to shard.
    expect(shards.length).toBe(5)
    expect(shards.map((row: any) => Number(row.parallel_index))).toEqual([0, 1, 2, 3, 4])
    expect(new Set(shards.map((row: any) => Number(row.parallel_total)))).toEqual(new Set([5]))

    /*
     * Named from one, indexed from zero. The name is for the person scanning a
     * failed run; the index is for the endpoint that hands the job its share.
     */
    expect(shards.map((row: any) => String(row.name))).toEqual([
      'suite (1/5)', 'suite (2/5)', 'suite (3/5)', 'suite (4/5)', 'suite (5/5)',
    ])

    // Each is independently claimable, which is what makes the shards parallel
    // rather than a list one machine works through.
    expect(shards.every((row: any) => String(row.state) === 'queued')).toBe(true)

    // And a job that asked for nothing is untouched - no `(1/1)` in its name,
    // no columns set, so nothing downstream has to special-case one of one.
    const plain = rows.find((row: any) => String(row.job_id) === 'once')

    expect(String(plain.name)).toBe('once')
    expect(plain.parallel_total).toBeNull()
  })
})

describe('cancel-on-build-failing', () => {
  /**
   * The run this workflow produced, found by the file it came from.
   *
   * Not by scanning for a job name: this repository accumulates workflows
   * across the tests in this file, so every dispatch creates several runs and a
   * job name is not a discriminator - a lesson learned by breaking a test three
   * describes down that was using one.
   */
  async function runOfWorkflow(path: string): Promise<number> {
    const row: any = await db
      .selectFrom('workflow_runs')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_runs.id as id'])
      .where('workflows.path', '=', path)
      .orderBy('workflow_runs.id', 'desc')
      .executeTakeFirst()

    return Number(row?.id ?? 0)
  }

  /** And it goes away again, so later dispatches see the repository as it was. */
  async function forget(path: string): Promise<void> {
    await db.deleteFrom('workflows').where('path', '=', path).execute()
  }

  test('a failed job stops the long sibling that asked, and leaves the others', async () => {
    if (!available)
      return

    const path = '.github/workflows/sunk.yml'

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path,
      source: `name: Sunk
on: push
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: ./unit
  browser:
    runs-on: ubuntu-latest
    reviewos:
      cancel-on-build-failing: true
    steps:
      - run: ./browser
  tell-the-channel:
    runs-on: ubuntu-latest
    steps:
      - run: ./tell
`,
      sha: '9'.repeat(40),
    })

    await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('k').padEnd(40, '0').slice(0, 40),
    })

    const runId = await runOfWorkflow(path)

    expect(runId).toBeGreaterThan(0)

    // The browser suite is on a machine; the unit tests have just gone red.
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', started_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .where('job_id', 'in', ['browser', 'tell-the-channel'])
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'failed', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .where('job_id', '=', 'unit')
      .execute()

    await settleRun(runId)

    const rows = await jobsOf(runId)

    /*
     * Asked to stop, not declared stopped: the machine holding it has to be
     * told and has to acknowledge. Nobody was going to read that suite's result
     * anyway - the run is failed whatever it says - and the machine it holds is
     * one nothing else can use.
     */
    expect(jobNamed(rows, 'browser').state).toBe('cancelling')
    expect(String(jobNamed(rows, 'browser').condition_reason)).toContain('had already failed')

    // And the job that did not ask keeps going. This is the whole reason the
    // attribute is opt-in: a job that reports the failure exists *because*
    // something failed.
    expect(jobNamed(rows, 'tell-the-channel').state).toBe('running')

    await forget(path)
  }, 120_000)

  test('a failure the workflow tolerates does not stop anybody', async () => {
    if (!available)
      return

    const path = '.github/workflows/tolerated.yml'

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path,
      source: `name: Tolerated
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: ./lint
  browser:
    runs-on: ubuntu-latest
    reviewos:
      cancel-on-build-failing: true
    steps:
      - run: ./browser
`,
      sha: '8'.repeat(40),
    })

    await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('t').padEnd(40, '0').slice(0, 40),
    })

    const runId = await runOfWorkflow(path)

    expect(runId).toBeGreaterThan(0)

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', started_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .where('job_id', '=', 'browser')
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'failed', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', runId)
      .where('job_id', '=', 'lint')
      .execute()

    await settleRun(runId)

    // `continue-on-error: true` means this failing is fine, so the run is not
    // sunk and there is nothing to stop anybody for.
    expect(jobNamed(await jobsOf(runId), 'browser').state).toBe('running')

    await forget(path)
  }, 120_000)
})

describe('a job that runs after a failure on purpose', () => {
  test('is queued while its ordinary sibling is skipped', async () => {
    if (!available)
      return

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/whatever-happened.yml',
      source: `name: Whatever happened
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: ./test
  publish-results:
    runs-on: ubuntu-latest
    needs: [test]
    reviewos:
      allow-dependency-failure: true
    steps:
      - run: ./publish
  deploy:
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - run: ./deploy
`,
      sha: 'f'.repeat(40),
    })

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: unique('f').padEnd(40, '0').slice(0, 40),
    })

    let runId = 0

    for (const candidate of result.created) {
      if (jobNamed(await jobsOf(candidate), 'publish-results'))
        runId = candidate
    }

    expect(runId).toBeGreaterThan(0)

    const test = jobNamed(await jobsOf(runId), 'test')

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'failed', finished_at: new Date().toISOString() } as any)
      .where('id', '=', Number(test.id))
      .execute()

    await settleRun(runId)

    const rows = await jobsOf(runId)

    // The whole point: results are published whatever happened.
    expect(String(jobNamed(rows, 'publish-results').state)).toBe('queued')

    // And the deploy is not, because it never asked for that.
    expect(String(jobNamed(rows, 'deploy').state)).toBe('skipped')
  }, 120_000)
})
