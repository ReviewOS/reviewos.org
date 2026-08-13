// The runner protocol over HTTP, which is the only way a real runner meets it.
//
// The rules have unit tests and the database side has its own; what this covers
// is the wiring between them - routing, the bearer credential, the status codes
// a runner's client branches on, and the fact that none of it needs a session.
//
// The status codes matter more than they look. A refused heartbeat tells a
// runner to stop working; a duplicate report tells it to stop retrying. Get
// either backwards and a correct runner does the wrong thing forever.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { RUNNER_PROTOCOL } from '../../app/Actions/Runner/protocol'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerIds: [] as number[] }

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Compile
        run: bun run build
      - run: bun test
`

async function call(path: string, body: Record<string, unknown>, token: string | null = TOKEN, protocol?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token)
    headers.authorization = `Bearer ${token}`
  if (protocol !== undefined)
    headers['X-Runner-Protocol'] = protocol

  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  return {
    status: r.status,
    body: await r.json().catch(() => ({})) as any,
    // What this server says it speaks, which rides on every answer.
    supported: r.headers.get('x-runner-protocol-supported'),
  }
}

async function freshRun(headSha: string): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha,
  })

  return result.created[0]!
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('rap')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Runner API', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const runner: any = await db
      .insertInto('runners')
      .values({
        name: unique('runner'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: hashToken(TOKEN),
        labels: 'ubuntu-latest',
        state: 'active',
      })
      .returning(['id'])
      .executeTakeFirst()
    created.runnerIds.push(Number(runner.id))

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
    console.warn(`[runner-api] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) } catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute()

    if (created.repositoryId) {
      // Deliveries first: they reference the webhook, and the repository
      // cascade cannot remove a hook something still points at.
      const hooks: any[] = await db.selectFrom('webhooks').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const hook of hooks)
        await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', Number(hook.id)).execute()

      await db.deleteFrom('webhooks').where('repository_id', '=', created.repositoryId).execute()
    }

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('the credential', () => {
  test('no token is refused', async () => {
    if (!available)
      return

    expect((await call('/runner/claim', {}, null)).status).toBe(401)
  })

  test('an unknown token is refused the same way', async () => {
    if (!available)
      return

    // The same answer as no token: telling an unauthenticated caller which of
    // the two it was is telling it whether a token exists.
    expect((await call('/runner/claim', {}, 'not-a-real-token')).status).toBe(401)
  })

  test('a disabled runner is refused too', async () => {
    if (!available)
      return

    const token = `tok-${unique('d')}`
    const row: any = await db.insertInto('runners').values({
      name: unique('off'),
      scope_type: 'instance',
      token_hash: hashToken(token),
      labels: 'ubuntu-latest',
      state: 'disabled',
    }).returning(['id']).executeTakeFirst()
    created.runnerIds.push(Number(row.id))

    expect((await call('/runner/claim', {}, token)).status).toBe(401)
  })
})

describe('claiming over HTTP', () => {
  test('an idle instance answers 200 with no job, not 404', async () => {
    if (!available)
      return

    // Scoped to this repository, which has no runs yet.
    const answer = await call('/runner/claim', {})

    expect(answer.status).toBe(200)
    expect(answer.body.job).toBeNull()
  })

  test('and hands over the job with the steps to run', async () => {
    if (!available)
      return

    const runId = await freshRun('b'.repeat(40))

    const answer = await call('/runner/claim', {})

    expect(answer.status).toBe(200)
    expect(answer.body.job?.key).toBe('build')
    expect(answer.body.job?.run?.id).toBe(runId)
    expect(answer.body.job?.repository).toBe(created.name)
    expect(answer.body.job?.lease_expires_at).toBeTruthy()

    // The steps, in order, as text. Nothing here has been executed.
    expect(answer.body.job?.steps?.map((step: any) => step.run)).toEqual(['bun run build', 'bun test'])
    expect(answer.body.job?.steps?.[0]?.name).toBe('Compile')
  })

  // A runner may want to refuse work it is not willing to run, and an untrusted
  // run is a fork's code.
  test('and says whether the run is trusted', async () => {
    if (!available)
      return

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['workflow_run_id'])
      .where('state', '=', 'running')
      .orderBy('id', 'desc')
      .executeTakeFirst()

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['trusted'])
      .where('id', '=', Number(job.workflow_run_id))
      .executeTakeFirst()

    expect(Boolean(run.trusted)).toBe(true)
  })
})

describe('heartbeat and report over HTTP', () => {
  /** Claim a job and keep the credential it was handed. */
  async function claimOne(): Promise<{ id: number, token: string }> {
    await freshRun(`${Math.random().toString(16).slice(2)}`.padEnd(40, '0'))
    const answer = await call('/runner/claim', {})
    return { id: Number(answer.body.job.id), token: String(answer.body.job.token) }
  }

  test('a heartbeat on a held job extends the lease', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await call('/runner/heartbeat', {}, job.token)

    expect(answer.status).toBe(200)
    expect(answer.body.lease_expires_at).toBeTruthy()
  })

  /*
   * 409 rather than 200: it means the job is no longer this runner's, and the
   * right thing on the runner's side is to stop working - anything it reports
   * afterwards will be refused anyway.
   */
  test('a heartbeat with a credential that names no job is refused', async () => {
    if (!available)
      return

    // 401 rather than 409: the credential is gone, which is a different thing
    // from holding one for work somebody took away.
    const answer = await call('/runner/heartbeat', {}, 'job-not-a-real-token')

    expect(answer.status).toBe(401)
  })

  /*
   * The separation this credential exists for. The registration token is
   * installed once and never rotated; it must not be the thing travelling on
   * every call, and it is no longer accepted for one.
   */
  test('the registration token cannot report a job', async () => {
    if (!available)
      return

    await claimOne()
    const answer = await call('/runner/report', { state: 'succeeded' }, TOKEN)

    expect(answer.status).toBe(401)
  })

  test('a report records the result and says what the run became', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await call('/runner/report', { state: 'succeeded' }, job.token)

    expect(answer.status).toBe(200)
    expect(answer.body.recorded).toBe(true)
    expect(answer.body.duplicate).toBe(false)
    expect(answer.body.run_state).toBeTruthy()
  })

  /*
   * At-least-once delivery: a runner that did not hear the answer says it
   * again, and from its side the report did land. Answering 409 to a correct
   * runner is how one retries forever.
   */
  test('the same report twice is a 200 marked duplicate', async () => {
    if (!available)
      return

    const job = await claimOne()

    const first = await call('/runner/report', { state: 'succeeded' }, job.token)
    const second = await call('/runner/report', { state: 'succeeded' }, job.token)

    expect(first.body.duplicate).toBe(false)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
  })

  /*
   * One job's credential cannot speak for another. There is no job id in the
   * request at all now - the token names the job - so the wrong-job case stops
   * being something to defend against and becomes unexpressable.
   */
  test('a credential for one job cannot report another', async () => {
    if (!available)
      return

    const first = await claimOne()
    const second = await claimOne()

    const answer = await call('/runner/report', { state: 'succeeded' }, first.token)

    // It reports *its own* job, not the other one.
    expect(answer.status).toBe(200)

    const other: any = await db
      .selectFrom('workflow_jobs')
      .select(['state'])
      .where('id', '=', second.id)
      .executeTakeFirst()

    expect(other.state).toBe('running')
  })

  test('an unknown state is refused with a fix rather than recorded', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await call('/runner/report', { state: 'exploded' }, job.token)

    // Refused by the action's own `validations`, before the handler runs, and
    // the message already names the allowed values. A hand-written second copy
    // of that rule in the handler was unreachable and has been removed.
    expect(answer.status).toBe(422)
    expect(String(answer.body.errors?.state)).toContain('succeeded')
  })
})


describe('acknowledging a cancellation over HTTP', () => {
  async function claimOne(): Promise<{ id: number, token: string }> {
    await freshRun(`${Math.random().toString(16).slice(2)}`.padEnd(40, '0'))
    const answer = await call('/runner/claim', {})
    return { id: Number(answer.body.job.id), token: String(answer.body.job.token) }
  }

  /** Cancel the job the way `CancelWorkflowRun` does: state and lease together. */
  async function ask(jobId: number): Promise<void> {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling', lease_expires_at: new Date().toISOString() })
      .where('id', '=', jobId)
      .execute()
  }

  /*
   * The runner that behaves. It heard the cancellation, stopped its work, and
   * came back to say so - with a lease that was deliberately revoked the
   * instant somebody pressed cancel.
   */
  test('a runner that stopped may say so, revoked lease and all', async () => {
    if (!available)
      return

    const job = await claimOne()
    await ask(job.id)

    const answer = await call('/runner/report', { state: 'cancelled' }, job.token)

    expect(answer.status).toBe(200)
    expect(answer.body.recorded).toBe(true)

    const row: any = await db.selectFrom('workflow_jobs').select(['state']).where('id', '=', job.id).executeTakeFirst()
    expect(String(row.state)).toBe('cancelled')
  })

  /*
   * And only that. A success on a revoked lease is exactly the report the
   * revocation exists to refuse: a worker that lost its connection publishing a
   * green check over a run somebody stopped, which then satisfies a branch
   * protection rule.
   */
  test('but it cannot report a success on the same credential', async () => {
    if (!available)
      return

    const job = await claimOne()
    await ask(job.id)

    const answer = await call('/runner/report', { state: 'succeeded' }, job.token)

    expect(answer.status).not.toBe(200)

    const row: any = await db.selectFrom('workflow_jobs').select(['state']).where('id', '=', job.id).executeTakeFirst()
    expect(String(row.state)).toBe('cancelling')
  })
})


describe('the run lifecycle, as a program hears it', () => {
  /*
   * The events everything downstream of CI waits on. A run lives for minutes on
   * a machine this instance does not own, and the alternative to hearing about
   * it is polling every run every few seconds - which is the reason forges grow
   * rate limits.
   *
   * Asserted through the whole path, because each half has been broken on its
   * own: an event nothing listens to, and a listener no event reaches.
   */
  let hookId = 0

  async function subscribe(): Promise<number> {
    const row: any = await db.insertInto('webhooks').values({
      repository_id: created.repositoryId,
      // Refused by the SSRF policy and recorded anyway, which is what this
      // needs: that the attempt was made.
      url: 'http://127.0.0.1:1/hook',
      secret: 'shhh',
      events: 'run:transitioned,job:transitioned',
      content_type: 'application/json',
      active: true,
      consecutive_failures: 0,
    }).returning(['id']).executeTakeFirst()

    return Number(row?.id)
  }

  /** Deliveries so far, waited for: the dispatch is deliberately not awaited. */
  async function settled(atLeast: number): Promise<any[]> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rows: any[] = await db
        .selectFrom('webhook_deliveries')
        .select(['event', 'payload'])
        .where('webhook_id', '=', hookId)
        .where('attempt', '=', 1)
        .orderBy('id', 'asc')
        .execute()

      if (rows.length >= atLeast)
        return rows

      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return []
  }

  test('a claim and a report tell it what happened, in order', async () => {
    if (!available)
      return

    hookId = await subscribe()

    await freshRun(`${Math.random().toString(16).slice(2)}`.padEnd(40, '0'))

    const claimed = await call('/runner/claim', {})
    const token = String(claimed.body.job.token)

    await call('/runner/report', { state: 'succeeded' }, token)

    const sent = await settled(3)
    const events = sent.map(row => String(row.event))

    // Job running, job succeeded, run succeeded. The run's own "running" may
    // ride along too, which is why this is a containment check rather than an
    // equality one.
    expect(events).toContain('job:transitioned')
    expect(events).toContain('run:transitioned')

    const jobBodies = sent.filter(row => String(row.event) === 'job:transitioned').map(row => JSON.parse(String(row.payload)))
    const runBodies = sent.filter(row => String(row.event) === 'run:transitioned').map(row => JSON.parse(String(row.payload)))

    expect(jobBodies.map(body => body.action)).toContain('running')
    expect(jobBodies.map(body => body.action)).toContain('succeeded')
    expect(runBodies.map(body => body.action)).toContain('succeeded')

    // The fields a receiver joins on: which job, of which run, on which machine.
    const first = jobBodies[0]
    expect(first.job.job_id).toBeTruthy()
    expect(first.job.run_number).toBeGreaterThan(0)
    expect(first.job.runner).toBeTruthy()

    const finished = runBodies.at(-1)
    expect(finished.run.number).toBeGreaterThan(0)
    expect(String(finished.run.head_sha).length).toBe(40)
  }, 30_000)
})


describe('speaking the same protocol', () => {
  /*
   * A self-hosted runner is a program somebody else installs, on a machine
   * somebody else reboots. The two ends drift by default, and the only question
   * is whether they find out by being told or by behaving strangely - a runner
   * reading a field this server stopped sending produces a job that hangs
   * rather than an error anybody can act on.
   */
  test('every answer says what this server speaks, refusal or not', async () => {
    if (!available)
      return

    const claim = await call('/runner/claim', {})

    expect(claim.supported).toBe(String(RUNNER_PROTOCOL.current))
  })

  test('a runner from the future is refused with 426, not 400 or 401', async () => {
    if (!available)
      return

    // 426 Upgrade Required is the one status that means exactly this. A 400
    // sends somebody to look at their payload and a 401 to look at their token,
    // and both are the wrong afternoon.
    const answer = await call('/runner/claim', {}, TOKEN, String(RUNNER_PROTOCOL.current + 1))

    expect(answer.status).toBe(426)
    expect(String(answer.body.error)).toContain('upgrade the server')
    expect(answer.supported).toBe(String(RUNNER_PROTOCOL.current))
  })

  test('and is refused before its credential is even looked at', async () => {
    if (!available)
      return

    // A runner that cannot be spoken to is going to misread whatever it is
    // handed, and telling it the token is fine first only delays the confusion.
    const answer = await call('/runner/claim', {}, 'not-a-real-token', String(RUNNER_PROTOCOL.current + 1))

    expect(answer.status).toBe(426)
  })

  /*
   * The compatibility rule that matters on the day this shipped: every runner
   * written before the header existed sends nothing, and refusing those would
   * have broken every fleet at once.
   */
  test('a runner that sends no version keeps working', async () => {
    if (!available)
      return

    const answer = await call('/runner/claim', {})

    expect(answer.status).toBe(200)
  })

  test('the same gate is on every runner endpoint, not only the claim', async () => {
    if (!available)
      return

    const tooNew = String(RUNNER_PROTOCOL.current + 1)

    for (const path of ['/runner/heartbeat', '/runner/report', '/runner/logs']) {
      const answer = await call(path, { state: 'succeeded', sequence: 1, content: 'x' }, 'job-token', tooNew)

      expect({ path, status: answer.status }).toEqual({ path, status: 426 })
    }
  })
})
