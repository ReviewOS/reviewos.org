// Waiting, against the real tables: the clock, the event, and the run that was
// told before it started listening.
//
// The property under all of it is that a held job holds nothing - no lease, no
// machine, no runner - which is what makes waiting three days affordable and is
// also why something has to come back and look. A wait nobody ends is a pull
// request whose checks never resolve.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  token: '',
}

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * A pipeline that waits twice: once for a clock, once for the world.
 *
 * `soak` ends by itself; `approval` waits to be told and gives up after an
 * hour. `ship` is behind the approval, which is the point of the whole feature.
 */
const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  soak:
    needs: [build]
    reviewos:
      await: 30m
  approval:
    needs: [build]
    reviewos:
      await:
        event: deploy-approved
        timeout: 1h
  ship:
    needs: [approval]
    runs-on: ubuntu-latest
    steps:
      - run: make ship
`

/** Start a run of that file, and return its number. */
async function dispatch(): Promise<number> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['id', 'number'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('id', 'desc')
    .executeTakeFirst()

  return Number(run.number)
}

/** The jobs of a run, by name. */
async function jobsOf(number: number): Promise<Record<string, any>> {
  const rows: any[] = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.job_id as job_id',
      'workflow_jobs.state as state',
      'workflow_jobs.kind as kind',
      'workflow_jobs.wake_at as wake_at',
      'workflow_jobs.outputs as outputs',
      'workflow_jobs.condition_reason as condition_reason',
      'workflow_jobs.workflow_run_id as run_id',
    ])
    .where('workflow_runs.repository_id', '=', created.repositoryId)
    .where('workflow_runs.number', '=', number)
    .execute()

  return Object.fromEntries(rows.map(row => [String(row.job_id), row]))
}

/** Finish the build job, which is what makes the waits eligible. */
async function finishBuild(number: number): Promise<void> {
  const { settleRun } = await import('../../app/Actions/Workflow/settle')
  const jobs = await jobsOf(number)

  await db
    .updateTable('workflow_jobs')
    .set({ state: 'succeeded', finished_at: new Date().toISOString() })
    .where('id', '=', Number(jobs.build.id))
    .execute()

  await settleRun(Number(jobs.build.run_id))
}

async function send(number: number, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/event`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, number, ...body }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('aw')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Await', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'await test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    /*
     * `actions: write` is what approving a gate needs, and sending an event
     * asks for the same thing: an event is what lets a held deployment through,
     * which is approval wearing different clothes.
     */
    for (const [scope, level] of [['checks', 'write'], ['contents', 'read'], ['actions', 'admin']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[await] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('a run that waits', () => {
  test('holds still with a deadline on the row, and holds no machine', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const jobs = await jobsOf(number)

    expect(String(jobs.soak.kind)).toBe('await')
    expect(String(jobs.soak.state)).toBe('paused')
    expect(String(jobs.approval.state)).toBe('paused')

    /*
     * `paused`, not `queued`: no runner may take this, and a job sitting in the
     * queue that is quietly refused every time a machine asks for it looks like
     * a fleet problem - which is how somebody ends up restarting runners over a
     * wait that is working exactly as written.
     */
    const deadline = Date.parse(String(jobs.soak.wake_at))

    expect(Number.isNaN(deadline)).toBe(false)
    // Thirty minutes, give or take the second this test took.
    expect(deadline - Date.now()).toBeGreaterThan(29 * 60_000)
    expect(deadline - Date.now()).toBeLessThan(31 * 60_000)

    // And the screen has something to say beyond "paused", which on its own
    // cannot tell a soak from a deployment nobody has triggered.
    expect(String(jobs.approval.condition_reason)).toContain('deploy-approved')

    // What is behind the wait has not moved.
    expect(String(jobs.ship.state)).toBe('blocked')
  }, 120_000)

  test('and the event ends it, with what came along as the job\'s outputs', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const { status, body } = await send(number, {
      event: 'deploy-approved',
      payload: JSON.stringify({ version: '4.2.0' }),
      key: unique('k'),
    })

    expect(status).toBe(200)
    expect(body.delivered).toBe(1)
    expect(body.duplicate).toBe(false)

    const jobs = await jobsOf(number)

    expect(String(jobs.approval.state)).toBe('succeeded')
    // Read by a later job as `needs.approval.outputs.version`, the same way it
    // reads any other job's - rather than through a second mechanism for
    // values that came from outside.
    expect(String(jobs.approval.outputs)).toContain('4.2.0')

    // And the graph moved: what was behind the wait is now work.
    expect(String(jobs.ship.state)).toBe('queued')

    // The soak is untouched. A typed event wakes what waited for it and
    // nothing else.
    expect(String(jobs.soak.state)).toBe('paused')
  }, 120_000)

  test('a repeat of the same key is told so rather than delivered twice', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const key = unique('k')
    const first = await send(number, { event: 'deploy-approved', key })
    const second = await send(number, { event: 'deploy-approved', key })

    expect(first.body.delivered).toBe(1)
    expect(first.body.duplicate).toBe(false)

    /*
     * What every webhook in the world does when it does not hear an answer.
     * Without the key these are two events, and a run waiting for one in a loop
     * would be let through twice on one deployment.
     */
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(second.body.delivered).toBe(1)
  }, 120_000)

  test('an event nothing is waiting for is still recorded, and found by the wait that starts after it', async () => {
    if (!available)
      return

    const number = await dispatch()

    /*
     * The lost wakeup, and the hardest kind of report to believe: the sender
     * saw a 200, the run sat until its timeout, and nothing anywhere says the
     * message was dropped. It was not dropped - it was recorded before anything
     * was listening, and nobody looked.
     */
    const early = await send(number, {
      event: 'deploy-approved',
      payload: JSON.stringify({ version: 'early' }),
      key: unique('k'),
    })

    expect(early.body.delivered).toBe(0)

    await finishBuild(number)

    const jobs = await jobsOf(number)

    expect(String(jobs.approval.state)).toBe('succeeded')
    expect(String(jobs.approval.outputs)).toContain('early')
    expect(String(jobs.approval.condition_reason)).toContain('already arrived')
  }, 120_000)
})

describe('a wait that runs out', () => {
  test('a sleep that ends is a job that succeeded, and the graph moves', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const jobs = await jobsOf(number)

    // The sweep looks at deadlines rather than at durations, so a test can move
    // one into the past instead of waiting half an hour.
    await db
      .updateTable('workflow_jobs')
      .set({ wake_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', Number(jobs.soak.id))
      .execute()

    const { endDueWaits } = await import('../../app/Actions/Workflow/awaits')
    const outcome = await endDueWaits()

    expect(outcome.slept).toBeGreaterThan(0)

    const after = await jobsOf(number)

    expect(String(after.soak.state)).toBe('succeeded')
    expect(after.soak.wake_at).toBeNull()
  }, 120_000)

  test('but an event that never arrived fails the job, so nothing goes green on silence', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const jobs = await jobsOf(number)

    await db
      .updateTable('workflow_jobs')
      .set({ wake_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', Number(jobs.approval.id))
      .execute()

    const { endDueWaits } = await import('../../app/Actions/Workflow/awaits')

    await endDueWaits()

    const after = await jobsOf(number)

    /*
     * A run that goes green on "nobody replied" is a green check for a
     * deployment nobody approved, which is the whole reason failing is the
     * default rather than the choice.
     */
    expect(String(after.approval.state)).toBe('failed')
    expect(String(after.approval.condition_reason)).toContain('in time')

    // And what was behind it never runs, rather than sitting blocked forever.
    expect(['skipped', 'failed']).toContain(String(after.ship.state))
  }, 120_000)

  test('and a wait already ended is not ended a second time', async () => {
    if (!available)
      return

    const number = await dispatch()

    await finishBuild(number)

    const jobs = await jobsOf(number)

    await db
      .updateTable('workflow_jobs')
      .set({ wake_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', Number(jobs.soak.id))
      .execute()

    const { endDueWaits } = await import('../../app/Actions/Workflow/awaits')

    await endDueWaits()

    // The second sweep finds nothing: the first cleared the deadline as it
    // ended the wait, which is what stops two overlapping sweeps deciding one
    // thing twice.
    const again = await endDueWaits()

    expect(again.slept).toBe(0)
  }, 120_000)
})

/*
 * Holding a run, which is the control between "let it finish" and "cancel it".
 * The property worth pinning is the one people get wrong about a pause: what is
 * already on a machine keeps going, and what stops is everything that has not
 * started.
 */
describe('a run somebody holds', () => {
  async function hold(number: number, action: 'pause' | 'resume'): Promise<{ status: number, body: any }> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/pause`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number, action }),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('is one no machine is offered work from, and is not one whose jobs were thrown away', async () => {
    if (!available)
      return

    const number = await dispatch()
    const { status, body } = await hold(number, 'pause')

    expect(status).toBe(200)
    expect(body.workflow_run.state).toBe('paused')
    expect(body.changed).toBe(true)

    const jobs = await jobsOf(number)

    /*
     * The job is still queued. Holding the *run* rather than rewriting every
     * job is what keeps this one state change instead of a rule spread across
     * the graph - and it is why resuming does not have to remember anything.
     */
    expect(String(jobs.build.state)).toBe('queued')

    // And the claim will not hand it out, because it only takes work from a run
    // in `queued` or `running`.
    const { claimNextJob } = await import('../../app/Actions/Runner/claim')

    const claimed = await claimNextJob({
      id: 0,
      runnerId: 'nobody',
      scopeType: 'instance',
      scopeId: null,
      labels: ['ubuntu-latest'],
      poolId: null,
    } as any)

    expect(claimed?.runId).not.toBe(Number(jobs.build.run_id))
  }, 120_000)

  test('holding it twice is not an error, because two people press one button', async () => {
    if (!available)
      return

    const number = await dispatch()

    await hold(number, 'pause')

    const again = await hold(number, 'pause')

    expect(again.status).toBe(200)
    expect(again.body.changed).toBe(false)
    expect(again.body.workflow_run.state).toBe('paused')
  }, 120_000)

  test('and resuming recomputes the state from the jobs rather than restoring one', async () => {
    if (!available)
      return

    const number = await dispatch()

    await hold(number, 'pause')

    const jobs = await jobsOf(number)

    /*
     * The case a remembered state gets wrong: the run was held while its work
     * was outstanding, and by the time somebody resumed it the jobs had all
     * finished. A stored "it was running" would put it back to a state it left
     * while nobody was watching.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() })
      .where('workflow_run_id', '=', Number(jobs.build.run_id))
      .execute()

    const resumed = await hold(number, 'resume')

    expect(resumed.status).toBe(200)
    expect(resumed.body.workflow_run.state).toBe('succeeded')

    const run = await db
      .selectFrom('workflow_runs')
      .select(['paused_at', 'state'])
      .where('id', '=', Number(jobs.build.run_id))
      .executeTakeFirst()

    expect(run.paused_at).toBeNull()
  }, 120_000)

  test('a run that has finished cannot be held, and says so rather than pretending', async () => {
    if (!available)
      return

    const number = await dispatch()
    const jobs = await jobsOf(number)

    await db
      .updateTable('workflow_runs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() })
      .where('id', '=', Number(jobs.build.run_id))
      .execute()

    const { status, body } = await hold(number, 'pause')

    expect(status).toBe(409)
    expect(String(body.error)).toContain('nothing left to hold')
  }, 120_000)
})
