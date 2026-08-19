// Restarting a job from one of its steps, against the real tables.
//
// The feature is only worth having if it skips work and only safe if the work
// it skips would have produced the same answer, so every test here is one of
// those two sentences: a restart that keeps eight minutes of checkout and
// toolchain, and a restart that refuses to because the definition moved
// underneath it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  token: '',
  workflowId: 0,
  versionId: 0,
  versionJobId: 0,
  runId: 0,
  jobId: 0,
  runnerId: 0,
}

/** What a machine is handed when it takes this run's job. */
const RUNNER_TOKEN = 'restart-step-runner-token'

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function api(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/rerun`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, number: 1, ...body }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Claim the job the way a machine does, over HTTP. */
async function claim(): Promise<any> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RUNNER_TOKEN}`, 'X-Runner-Protocol': '1' },
    body: '{}',
  })

  const body: any = await answer.json().catch(() => null)

  return body?.job ?? null
}

/** The job's steps in order, as rows. */
async function steps(): Promise<any[]> {
  return db
    .selectFrom('workflow_steps')
    .select(['position', 'name', 'step_id', 'state', 'outputs', 'reused_from_attempt', 'exit_code', 'attempts', 'error'])
    .where('workflow_job_id', '=', created.jobId)
    .orderBy('position')
    .execute()
}

async function jobRow(): Promise<any> {
  return db
    .selectFrom('workflow_jobs')
    .select(['state', 'attempt', 'resume_from_step'])
    .where('id', '=', created.jobId)
    .executeTakeFirst()
}

/**
 * The four steps of a job that failed at its last one.
 *
 * Written twice: once as the definition, once as what ran. That duplication is
 * the run's own design - a finished run has to stay readable after its workflow
 * file is edited - and it is exactly what the reuse decision compares.
 */
const DEFINITION = [
  { position: 0, name: 'checkout', step_id: 'checkout', command: 'git checkout' },
  { position: 1, name: 'toolchain', step_id: 'toolchain', command: 'install bun' },
  { position: 2, name: 'build', step_id: 'build', command: 'make build' },
  { position: 3, name: 'test', step_id: 'test', command: 'make test' },
]

/** Put the run back to "failed at the last step", whatever a test did to it. */
async function seedFinishedRun(): Promise<void> {
  const now = new Date().toISOString()

  await db
    .updateTable('workflow_runs')
    .set({ state: 'failed', attempt: 1, finished_at: now })
    .where('id', '=', created.runId)
    .execute()

  await db
    .updateTable('workflow_jobs')
    .set({ state: 'failed', attempt: 1, resume_from_step: null, finished_at: now })
    .where('id', '=', created.jobId)
    .execute()

  for (const step of DEFINITION) {
    const failed = step.position === 3

    await db
      .updateTable('workflow_steps')
      .set({
        state: failed ? 'failed' : 'succeeded',
        exit_code: failed ? 1 : 0,
        started_at: now,
        finished_at: now,
        queued_ms: 100,
        active_ms: 60_000,
        // Only `build` names a value, which is the ordinary shape: most steps
        // produce nothing, and a step that produced nothing is still skippable.
        outputs: step.position === 2 ? JSON.stringify({ artifact: 'app.tar.gz' }) : null,
        reused_from_attempt: null,
      })
      .where('workflow_job_id', '=', created.jobId)
      .where('position', '=', step.position)
      .execute()
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('rs')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Restart', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        path: '.github/workflows/ci.yml',
        name: 'CI',
        state: 'active',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.workflowId = Number(workflow.id)

    const version: any = await db
      .insertInto('workflow_versions')
      .values({
        workflow_id: created.workflowId,
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/ci.yml',
        content_digest: unique('d').padEnd(64, '0').slice(0, 64),
        on_push: true,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.versionId = Number(version.id)

    const versionJob: any = await db
      .insertInto('workflow_version_jobs')
      .values({
        workflow_version_id: created.versionId,
        repository_id: created.repositoryId,
        job_id: 'build',
        name: 'build',
        position: 0,
        runs_on: 'ubuntu-latest',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.versionJobId = Number(versionJob.id)

    for (const step of DEFINITION) {
      await db
        .insertInto('workflow_version_steps')
        .values({
          workflow_version_job_id: created.versionJobId,
          repository_id: created.repositoryId,
          position: step.position,
          name: step.name,
          step_id: step.step_id,
          command: step.command,
        })
        .execute()
    }

    const run: any = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: created.versionId,
        repository_id: created.repositoryId,
        number: 1,
        state: 'failed',
        event: 'push',
        event_ref: 'refs/heads/main',
        head_sha: 'a'.repeat(40),
        definition_sha: 'a'.repeat(40),
        trusted: true,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.runId = Number(run.id)

    const job: any = await db
      .insertInto('workflow_jobs')
      .values({
        workflow_run_id: created.runId,
        repository_id: created.repositoryId,
        job_id: 'build',
        name: 'build',
        position: 0,
        state: 'failed',
        runs_on: 'ubuntu-latest',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.jobId = Number(job.id)

    for (const step of DEFINITION) {
      await db
        .insertInto('workflow_steps')
        .values({
          workflow_job_id: created.jobId,
          repository_id: created.repositoryId,
          position: step.position,
          name: step.name,
          step_id: step.step_id,
          command: step.command,
          state: 'pending',
        })
        .execute()
    }

    await seedFinishedRun()

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'restart test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['checks', 'write'], ['contents', 'read'], ['actions', 'admin']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(RUNNER_TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner.id)

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[restart-step] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('restarting from a step', () => {
  test('keeps what the steps before it recorded, and says who produced them', async () => {
    if (!available)
      return

    const { status, body } = await api({ scope: 'step', job: 'build', step: 'test' })

    expect(status).toBe(200)
    expect(body.workflow_run.attempt).toBe(2)
    // Three kept: the checkout, the toolchain, and the build whose value the
    // step being restarted reads.
    expect(body.reused).toBe(3)
    expect(String(body.reason ?? '')).toBe('')

    const rows = await steps()

    // The kept three are exactly as they were, and say so.
    expect(rows.slice(0, 3).map(row => String(row.state))).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(rows.slice(0, 3).map(row => Number(row.reused_from_attempt))).toEqual([1, 1, 1])
    expect(String(rows[2].outputs)).toContain('app.tar.gz')

    /*
     * And the step being restarted is pending again with its failure cleared.
     * A row that kept `exit_code: 1` beside a queued job is a screen claiming a
     * result for work that has not happened.
     */
    expect(String(rows[3].state)).toBe('pending')
    expect(rows[3].exit_code).toBeNull()
    expect(rows[3].reused_from_attempt).toBeNull()

    const job = await jobRow()

    expect(String(job.state)).toBe('queued')
    expect(Number(job.attempt)).toBe(2)
    expect(Number(job.resume_from_step)).toBe(3)
  }, 120_000)

  test('and a second restart still credits the attempt that did the work', async () => {
    if (!available)
      return

    /*
     * The number is about the work, not about how many restarts have happened
     * since. A result produced on attempt one still says one after being kept
     * through attempts two and three, or the link goes to a log that shows the
     * step being skipped.
     */
    await db
      .updateTable('workflow_runs')
      .set({ state: 'failed', finished_at: new Date().toISOString() })
      .where('id', '=', created.runId)
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'failed', finished_at: new Date().toISOString() })
      .where('id', '=', created.jobId)
      .execute()

    await db
      .updateTable('workflow_steps')
      .set({ state: 'failed', exit_code: 1, finished_at: new Date().toISOString() })
      .where('workflow_job_id', '=', created.jobId)
      .where('position', '=', 3)
      .execute()

    const { body } = await api({ scope: 'step', job: 'build', step: '4' })

    expect(body.reused).toBe(3)

    const rows = await steps()

    expect(rows.slice(0, 3).map(row => Number(row.reused_from_attempt))).toEqual([1, 1, 1])
  }, 120_000)
})

describe('what a restart refuses to skip', () => {
  test('a step whose definition changed, and everything after it', async () => {
    if (!available)
      return

    await seedFinishedRun()

    /*
     * The toolchain step now installs something else. Its recorded result
     * answers a question nobody is asking, and so does everything downstream of
     * it - a step reads the workspace its predecessors left behind.
     */
    await db
      .updateTable('workflow_version_steps')
      .set({ command: 'install bun 1.3' })
      .where('workflow_version_job_id', '=', created.versionJobId)
      .where('position', '=', 1)
      .execute()

    const { status, body } = await api({ scope: 'step', job: 'build', step: 'test' })

    expect(status).toBe(200)
    // Only the checkout survives, and the answer says where it stopped rather
    // than quietly starting three steps earlier than it was asked to.
    expect(body.reused).toBe(1)
    expect(String(body.reason)).toContain('begins at step 2')

    const rows = await steps()

    expect(Number(rows[0].reused_from_attempt)).toBe(1)
    expect(rows.slice(1).map(row => String(row.state))).toEqual(['pending', 'pending', 'pending'])
    expect(Number(await jobRow().then(job => job.resume_from_step))).toBe(1)

    await db
      .updateTable('workflow_version_steps')
      .set({ command: 'install bun' })
      .where('workflow_version_job_id', '=', created.versionJobId)
      .where('position', '=', 1)
      .execute()
  }, 120_000)

  test('a step whose result was too big to keep', async () => {
    if (!available)
      return

    await seedFinishedRun()

    /*
     * A value the store refused is recorded as a marker rather than as itself,
     * and skipping the step would hand the ones after it that marker as though
     * it were the answer. An empty column is a different fact - a step that
     * produced nothing - and stays skippable, which the first test relies on.
     */
    const { boundedValue } = await import('../../app/Actions/Runner/report')

    await db
      .updateTable('workflow_steps')
      .set({ outputs: JSON.stringify({ artifact: boundedValue('x'.repeat(9000), 2000) }) })
      .where('workflow_job_id', '=', created.jobId)
      .where('position', '=', 2)
      .execute()

    const { body } = await api({ scope: 'step', job: 'build', step: 'test' })

    expect(body.reused).toBe(2)
    expect(String(body.reason)).toContain('recorded no result')
  }, 120_000)

  test('a step nobody can name, which is a typo rather than a restart', async () => {
    if (!available)
      return

    await seedFinishedRun()

    const { status, body } = await api({ scope: 'step', job: 'build', step: 'deploy' })

    expect(status).toBe(422)
    expect(String(body.error)).toContain('no step')

    // And nothing moved: the run is still the failed one it was.
    expect(Number((await jobRow()).attempt)).toBe(1)
  }, 120_000)

  test('and a step restart with no job named at all', async () => {
    if (!available)
      return

    const { status, body } = await api({ scope: 'step', step: '2' })

    expect(status).toBe(422)
    expect(String(body.error)).toContain('needs a job')
  }, 120_000)
})

describe('what the machine is handed', () => {
  test('the step to start at, and the kept steps with what they produced', async () => {
    if (!available)
      return

    await seedFinishedRun()
    await api({ scope: 'step', job: 'build', step: 'test' })

    const job = await claim()

    expect(job).not.toBeNull()
    expect(Number(job.resume_from)).toBe(3)

    /*
     * The kept steps travel in the list rather than being removed from it: the
     * runner reports results by position, and a list with holes in it would
     * renumber every step after the skip onto the wrong row.
     */
    expect(job.steps.length).toBe(4)
    expect(job.steps.map((step: any) => step.reused)).toEqual([true, true, true, false])

    /*
     * And the build step's value goes with it, because `steps.build.outputs`
     * is what the step being restarted reads. A skipped step whose outputs did
     * not travel is a skipped step that breaks the one after it.
     */
    expect(job.steps[2].outputs.artifact).toBe('app.tar.gz')
    expect(job.steps[3].outputs).toBeNull()
  }, 120_000)
})

describe('a step result that has to survive the machine', () => {
  test('lands on the heartbeat, before the job is over', async () => {
    if (!available)
      return

    await seedFinishedRun()
    await api({ scope: 'all' })

    const job = await claim()

    expect(job).not.toBeNull()

    /*
     * The case the conclusion cannot cover: a runner that dies at step nine
     * has reported nothing at all, so the rows would say the job never started
     * and a restart would have nothing to keep. The heartbeat is the request
     * the runner has to make anyway, so the results ride it.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(job.token)}`,
        'X-Runner-Protocol': '1',
      },
      body: JSON.stringify({
        steps: [
          { position: 0, state: 'succeeded', exit_code: 0, queued_ms: 10, active_ms: 900 },
          { position: 1, state: 'failed', exit_code: 7, attempt: 2, error: 'toolchain exited 7' },
        ],
      }),
    })

    const body: any = await answer.json()

    expect(answer.status).toBe(200)
    expect(body.steps_recorded).toBe(2)
    expect(String(body.lease_expires_at ?? '')).not.toBe('')

    const rows = await steps()

    expect(String(rows[0].state)).toBe('succeeded')
    expect(String(rows[1].state)).toBe('failed')
    expect(Number(rows[1].exit_code)).toBe(7)
    // Stated by the runner rather than counted here, so a report arriving twice
    // records the same number twice.
    expect(Number(rows[1].attempts)).toBe(2)
    expect(String(rows[1].error)).toContain('exited 7')

    // And the steps that have not run keep saying so.
    expect(rows.slice(2).map(row => String(row.state))).toEqual(['pending', 'pending'])
  }, 120_000)

  test('and a try at a step is a row, so flakiness has something to count', async () => {
    if (!available)
      return

    const attempts: any[] = await db
      .selectFrom('workflow_step_attempts')
      .innerJoin('workflow_steps', 'workflow_steps.id', '=', 'workflow_step_attempts.workflow_step_id')
      .select(['workflow_step_attempts.attempt as attempt', 'workflow_step_attempts.state as state', 'workflow_steps.position as position'])
      .where('workflow_steps.workflow_job_id', '=', created.jobId)
      .orderBy('workflow_steps.position')
      .execute()

    expect(attempts.map(row => Number(row.position))).toEqual([0, 1])
    expect(attempts.map(row => Number(row.attempt))).toEqual([1, 2])
    expect(attempts.map(row => String(row.state))).toEqual(['succeeded', 'failed'])
  }, 120_000)

  test('and the same report arriving twice records the same row, not a second try', async () => {
    if (!available)
      return

    /*
     * Delivery is at-least-once, so a runner that did not hear the answer says
     * it again. Every field is stated rather than accumulated, which is what
     * makes the repeat harmless - a counter this end would climb every time the
     * network hiccupped.
     */
    const job = await db
      .selectFrom('workflow_jobs')
      .select(['job_token_hash'])
      .where('id', '=', created.jobId)
      .executeTakeFirst()

    expect(job).not.toBeNull()

    const { recordSteps } = await import('../../app/Actions/Runner/report')

    await recordSteps(created.jobId, [{ position: 1, state: 'failed', exitCode: 7, attempt: 2 }], new Date())

    const attempts: any[] = await db
      .selectFrom('workflow_step_attempts')
      .innerJoin('workflow_steps', 'workflow_steps.id', '=', 'workflow_step_attempts.workflow_step_id')
      .select(['workflow_step_attempts.id as id'])
      .where('workflow_steps.workflow_job_id', '=', created.jobId)
      .where('workflow_steps.position', '=', 1)
      .execute()

    expect(attempts.length).toBe(1)
  }, 120_000)
})

describe('an ordinary re-run', () => {
  test('starts every step from the top, because a fresh machine has none of the workspace', async () => {
    if (!available)
      return

    await seedFinishedRun()

    const { status, body } = await api({ scope: 'all' })

    expect(status).toBe(200)
    expect(body.reused).toBe(0)

    const rows = await steps()

    /*
     * Every step pending, and until this was wired the rows kept the last
     * attempt's states - so the screen showed a queued job made of succeeded
     * steps, which reads as work that is somehow both waiting and done.
     */
    expect(rows.map(row => String(row.state))).toEqual(['pending', 'pending', 'pending', 'pending'])
    expect(rows.every(row => row.outputs === null)).toBe(true)
    expect(rows.every(row => row.reused_from_attempt === null)).toBe(true)
    expect((await jobRow()).resume_from_step).toBeNull()
  }, 120_000)
})
