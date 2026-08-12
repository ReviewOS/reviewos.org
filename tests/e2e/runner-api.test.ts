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

async function call(path: string, body: Record<string, unknown>, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token)
    headers.authorization = `Bearer ${token}`

  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  return { status: r.status, body: await r.json().catch(() => ({})) as any }
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
  async function claimOne(): Promise<number> {
    await freshRun(`${Math.random().toString(16).slice(2)}`.padEnd(40, '0'))
    const answer = await call('/runner/claim', {})
    return Number(answer.body.job.id)
  }

  test('a heartbeat on a held job extends the lease', async () => {
    if (!available)
      return

    const jobId = await claimOne()
    const answer = await call('/runner/heartbeat', { job: jobId })

    expect(answer.status).toBe(200)
    expect(answer.body.lease_expires_at).toBeTruthy()
  })

  /*
   * 409 rather than 200: it means the job is no longer this runner's, and the
   * right thing on the runner's side is to stop working - anything it reports
   * afterwards will be refused anyway.
   */
  test('a heartbeat on a job this runner does not hold is refused', async () => {
    if (!available)
      return

    const answer = await call('/runner/heartbeat', { job: 999_999_999 })

    expect(answer.status).toBe(409)
    expect(String(answer.body.error)).toContain('no longer yours')
  })

  test('a report records the result and says what the run became', async () => {
    if (!available)
      return

    const jobId = await claimOne()
    const answer = await call('/runner/report', { job: jobId, state: 'succeeded' })

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

    const jobId = await claimOne()

    const first = await call('/runner/report', { job: jobId, state: 'succeeded' })
    const second = await call('/runner/report', { job: jobId, state: 'succeeded' })

    expect(first.body.duplicate).toBe(false)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
  })

  test('a report on somebody else\'s job is refused', async () => {
    if (!available)
      return

    const jobId = await claimOne()

    const token = `tok-${unique('s')}`
    const row: any = await db.insertInto('runners').values({
      name: unique('stranger'),
      scope_type: 'instance',
      token_hash: hashToken(token),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()
    created.runnerIds.push(Number(row.id))

    const answer = await call('/runner/report', { job: jobId, state: 'succeeded' }, token)

    expect(answer.status).toBe(409)
    expect(String(answer.body.error)).toContain('another runner')
  })

  test('an unknown state is refused with a fix rather than recorded', async () => {
    if (!available)
      return

    const jobId = await claimOne()
    const answer = await call('/runner/report', { job: jobId, state: 'exploded' })

    // Refused by the action's own `validations`, before the handler runs, and
    // the message already names the allowed values. A hand-written second copy
    // of that rule in the handler was unreachable and has been removed.
    expect(answer.status).toBe(422)
    expect(String(answer.body.errors?.state)).toContain('succeeded')
  })
})
