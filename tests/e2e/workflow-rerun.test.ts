// Running a run again, against the real tables and the real endpoint.
//
// The property this file is about is the one a re-run button usually breaks:
// **the attempt that failed stays readable.** Somebody re-runs a job to compare
// it against the failure, and a system that overwrites the failure has thrown
// away the reason they pressed it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendLog } from '../../app/Actions/Runner/logs'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  token: '',
  versionId: 0,
  runId: 0,
  jobs: {} as Record<string, number>,
}

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

/** The run's jobs, by name. */
async function jobs(): Promise<Record<string, any>> {
  const rows: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'attempt', 'outputs', 'started_at', 'finished_at'])
    .where('workflow_run_id', '=', created.runId)
    .execute()

  return Object.fromEntries(rows.map(row => [String(row.job_id), row]))
}

async function runRow(): Promise<any> {
  return db
    .selectFrom('workflow_runs')
    .select(['state', 'attempt', 'finished_at'])
    .where('id', '=', created.runId)
    .executeTakeFirst()
}

/** A finished run: build succeeded, test failed, deploy was skipped because of it. */
async function seedFinishedRun(): Promise<void> {
  const now = new Date().toISOString()

  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: 1,
    state: 'failed',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: 'a'.repeat(40),
    definition_sha: 'a'.repeat(40),
    trusted: true,
    started_at: now,
    finished_at: now,
  }).returning(['id']).executeTakeFirst()

  created.runId = Number(run.id)

  for (const [name, state, needs] of [
    ['build', 'succeeded', null],
    ['test', 'failed', null],
    ['deploy', 'skipped', 'test'],
  ] as Array<[string, string, string | null]>) {
    const row: any = await db.insertInto('workflow_jobs').values({
      workflow_run_id: created.runId,
      job_id: name,
      name,
      position: Object.keys(created.jobs).length,
      state,
      needs,
      runs_on: 'ubuntu-latest',
      started_at: now,
      finished_at: now,
      outputs: name === 'build' ? JSON.stringify({ version: '1.0.0' }) : null,
    }).returning(['id']).executeTakeFirst()

    created.jobs[name] = Number(row.id)
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('rr')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Rerun', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const version: any = await db
      .insertInto('workflow_versions')
      .values({
        workflow_id: Number(workflow.id),
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/ci.yml',
        content_digest: unique('d').padEnd(64, '0').slice(0, 64),
        on_push: true,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.versionId = Number(version.id)

    await seedFinishedRun()

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'rerun test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    // `checks: write` is what cancelling a run needs, and re-running one asks
    // for the same thing: both spend the fleet's machines on this repository.
    for (const [scope, level] of [['checks', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[rerun] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('re-running the failed jobs', () => {
  test('puts the failure and what it blocked back, and leaves the rest alone', async () => {
    if (!available)
      return

    // The failing attempt's log, which has to survive this.
    await appendLog({
      jobId: created.jobs.test!,
      sequence: 1,
      content: 'the assertion that failed\n',
      stream: 'stdout',
    })

    const { status, body } = await api({ scope: 'failed' })

    expect(status).toBe(200)
    expect(body.workflow_run.attempt).toBe(2)
    expect(body.jobs).toBe(2)

    const after = await jobs()

    // `test` is queued again on a second attempt; `deploy` is blocked behind it
    // rather than queued, because it has a dependency.
    expect(String(after.test.state)).toBe('queued')
    expect(Number(after.test.attempt)).toBe(2)
    expect(String(after.deploy.state)).toBe('blocked')

    // And `build` is untouched, outputs and all: nothing about it was in doubt.
    expect(String(after.build.state)).toBe('succeeded')
    expect(Number(after.build.attempt)).toBe(1)
    expect(String(after.build.outputs)).toContain('1.0.0')

    const run = await runRow()

    expect(String(run.state)).toBe('queued')
    expect(Number(run.attempt)).toBe(2)
    expect(run.finished_at).toBeNull()
  }, 120_000)

  test('and the failing attempt\'s log is still there', async () => {
    if (!available)
      return

    /*
     * The whole point. Somebody re-running a job is comparing it against the
     * failure; a system that erased the failure threw away the reason they
     * pressed the button.
     */
    const rows: any[] = await db
      .selectFrom('workflow_job_logs')
      .select(['attempt', 'content'])
      .where('workflow_job_id', '=', created.jobs.test!)
      .execute()

    expect(rows.length).toBe(1)
    expect(Number(rows[0].attempt)).toBe(1)
    expect(String(rows[0].content)).toContain('the assertion that failed')
  }, 120_000)

  test('a second attempt writes its log under its own attempt number', async () => {
    if (!available)
      return

    await appendLog({
      jobId: created.jobs.test!,
      sequence: 1,
      content: 'this time it passed\n',
      stream: 'stdout',
    })

    const rows: any[] = await db
      .selectFrom('workflow_job_logs')
      .select(['attempt', 'content'])
      .where('workflow_job_id', '=', created.jobs.test!)
      .orderBy('attempt')
      .execute()

    // Two rows with the same sequence number, told apart by their attempt -
    // which is why the sequence index has to be per attempt rather than per job.
    expect(rows.map(row => Number(row.attempt))).toEqual([1, 2])
    expect(String(rows[1].content)).toContain('this time it passed')
  }, 120_000)
})

describe('what a re-run refuses', () => {
  test('a run that has not finished', async () => {
    if (!available)
      return

    /*
     * Two attempts of one job in flight is exactly what the lease exists to
     * prevent, and the second one's report would land on a row the first is
     * still holding.
     */
    const { status, body } = await api({ scope: 'all' })

    expect(status).toBe(409)
    expect(String(body.error)).toContain('has not finished')
  }, 120_000)

  test('and a scope that matches nothing says so rather than doing nothing', async () => {
    if (!available)
      return

    await db
      .updateTable('workflow_runs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('id', '=', created.runId)
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded' } as any)
      .where('workflow_run_id', '=', created.runId)
      .execute()

    const nothing = await api({ scope: 'failed' })

    expect(nothing.status).toBe(422)
    expect(String(nothing.body.error)).toContain('nothing to run again')

    const ghost = await api({ scope: 'job', job: 'nobody' })

    expect(ghost.status).toBe(422)
    expect(String(ghost.body.error)).toContain('no job by that name')
  }, 120_000)

  test('but re-running everything on a green run is allowed', async () => {
    if (!available)
      return

    // "The world changed" - a dependency was fixed, a machine was replaced.
    // Nothing about the run itself says it should not be run again.
    const { status, body } = await api({ scope: 'all' })

    expect(status).toBe(200)
    expect(body.jobs).toBe(3)
    expect(body.workflow_run.attempt).toBe(3)
  }, 120_000)
})

describe('stopping one job', () => {
  async function cancelJob(job: string): Promise<{ status: number, body: any }> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/cancel-job`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number: 1, job }),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('leaves the rest of the run alone, and settles what depended on it', async () => {
    if (!available)
      return

    /*
     * The case cancelling a whole run cannot serve: one job stuck on a machine
     * that has gone quiet, and the others are work nobody wants to throw away.
     */
    await db
      .updateTable('workflow_runs')
      .set({ state: 'running', finished_at: null } as any)
      .where('id', '=', created.runId)
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', started_at: new Date().toISOString(), finished_at: null } as any)
      .where('workflow_run_id', '=', created.runId)
      .where('job_id', '=', 'test')
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'blocked', finished_at: null } as any)
      .where('workflow_run_id', '=', created.runId)
      .where('job_id', '=', 'deploy')
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'running', finished_at: null } as any)
      .where('workflow_run_id', '=', created.runId)
      .where('job_id', '=', 'build')
      .execute()

    const { status, body } = await cancelJob('test')

    expect(status).toBe(200)
    expect(body.cancelled).toBe(true)

    const after = await jobs()

    /*
     * Asked to stop rather than declared stopped, with the lease revoked in the
     * same write - so whatever holds it can no longer report a result over a
     * decision that has been made.
     */
    expect(String(after.test.state)).toBe('cancelling')

    /*
     * And `deploy` is *still blocked*, which is right rather than a gap: the
     * cancellation is cooperative, so until the machine acknowledges it the
     * job might yet report a success, and skipping its dependants first would
     * be the control plane deciding an outcome it cannot see. A job that had
     * never started would be `cancelled` outright and its dependants skipped
     * in the same pass, because there is nobody to wait for.
     */
    expect(String(after.deploy.state)).toBe('blocked')

    // The sibling nobody asked about is untouched.
    expect(String(after.build.state)).toBe('running')

    // Once the runner acknowledges, the graph resolves: nothing that needed
    // this job can run now, and a run left holding those blocked is a pull
    // request whose checks stay pending on work that ended.
    const { settleRun } = await import('../../app/Actions/Workflow/settle')

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', created.runId)
      .where('job_id', '=', 'test')
      .execute()

    await settleRun(created.runId)

    expect(String((await jobs()).deploy.state)).toBe('skipped')
  }, 120_000)

  test('a name nobody has is a 404 rather than a silent success', async () => {
    if (!available)
      return

    expect((await cancelJob('ghost')).status).toBe(404)
  }, 120_000)
})
