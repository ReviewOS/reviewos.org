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
    .select(['id', 'job_id', 'state', 'kind', 'settings', 'group_label', 'outputs', 'approved_by_id', 'triggered_run_id', 'condition_reason'])
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
