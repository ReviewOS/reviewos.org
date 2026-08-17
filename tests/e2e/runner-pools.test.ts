// Pools and queues against the real claim, and the operator surface that
// drives them.
//
// The unit tests say the rules are right. This says the *claim* asks them - a
// boundary that the dispatcher does not enforce is documentation - and that
// draining a queue does what an operator taking machines out of service
// actually needs: no new work, nothing failed, and one call to undo it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { splitLabels } from '../../app/Actions/Runner/protocol'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  adminToken: '',
  repositoryId: 0,
  otherRepositoryId: 0,
  handle: '',
  name: '',
  runnerIds: [] as number[],
  poolIds: [] as number[],
}

let available = false
let db: any = null
let server: any = null
let port = 0

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fleet(body: Record<string, unknown>, token = created.adminToken): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/instance/fleet`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
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

async function makeRunner(repositoryId: number): Promise<any> {
  const row: any = await db
    .insertInto('runners')
    .values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: repositoryId,
      token_hash: hashToken(unique('tok')),
      labels: 'ubuntu-latest',
      state: 'active',
    })
    .returning(['id'])
    .executeTakeFirst()

  created.runnerIds.push(Number(row.id))

  return runnerFacts(Number(row.id))
}

/** A run of the workflow above, with everything older put to bed. */
async function freshRun(repositoryId: number, headSha: string): Promise<number> {
  const previous: any[] = await db.selectFrom('workflow_runs').select(['id']).where('repository_id', '=', repositoryId).execute()

  if (previous.length > 0) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
      .where('state', 'in', ['blocked', 'queued', 'running'])
      .where('workflow_run_id', 'in', previous.map((row: any) => Number(row.id)))
      .execute()
  }

  const result = await dispatchPush({ repositoryId, event: { ref: 'refs/heads/main' }, headSha })

  return result.created[0]!
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('flt')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Fleet Admin', email: `${created.handle}@example.com`, handle: created.handle, password: 'x', is_admin: true })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'fleet test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).execute()

    created.adminToken = token.token

    for (const key of ['name', 'otherRepositoryId'] as const) {
      const repositoryName = unique('repo')

      const repository: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.ownerId,
          name: repositoryName,
          visibility: 'public',
          default_branch: 'main',
          disk_path: `${created.handle}/${repositoryName}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      if (key === 'name') {
        created.name = repositoryName
        created.repositoryId = Number(repository?.id)
      }
      else {
        created.otherRepositoryId = Number(repository?.id)
      }

      await syncWorkflowFile({
        repositoryId: Number(repository?.id),
        ownerType: 'user',
        ownerId: created.ownerId,
        path: '.github/workflows/ci.yml',
        source: CI,
        sha: 'a'.repeat(40),
      })
    }

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[runner-pools] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    server?.stop?.()

    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute().catch(() => {})

    for (const id of created.poolIds)
      await db.deleteFrom('runner_pools').where('id', '=', id).execute().catch(() => {})

    for (const id of [created.repositoryId, created.otherRepositoryId])
      if (id)
        await db.deleteFrom('repositories').where('id', '=', id).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('the fleet surface', () => {
  let poolId = 0
  let queueId = 0

  test('is not there at all for somebody who is not an administrator', async () => {
    if (!available)
      return

    const { status } = await fleet({ operation: 'list' }, 'not-a-token')

    // 404 rather than 403: whether this instance has a fleet is not something
    // to confirm to a stranger.
    expect(status).toBe(404)
  })

  test('makes a pool and a queue', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: 'Deployment', reason: 'machines with the release credentials' })

    expect(pool.status).toBe(200)
    poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: 'linux-x64-large' })

    expect(queue.status).toBe(200)
    expect(queue.body.queue.state).toBe('active')
    queueId = Number(queue.body.queue.id)
  })

  test('and says in words that a pool with no repositories serves them all', async () => {
    if (!available)
      return

    const { body } = await fleet({ operation: 'list' })
    const pool = body.pools.find((entry: any) => Number(entry.id) === poolId)

    /*
     * The rule people get backwards. A screen that shows `repositories: []`
     * invites exactly that mistake, so the answer is a sentence rather than an
     * empty array.
     */
    expect(pool.serves).toBe('every repository')
  })
})

describe('a pool that lists repositories', () => {
  test('serves those and refuses the rest, at the claim', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: unique('Restricted') })
    const poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: 'restricted-x64' })
    const queueId = Number(queue.body.queue.id)

    // The pool serves the *other* repository, and this runner is in it.
    await fleet({ operation: 'assign-repository', pool: poolId, repository: created.otherRepositoryId })

    const runner = await makeRunner(created.repositoryId)

    await fleet({ operation: 'assign-runner', runner: runner.id, queue: queueId })

    await freshRun(created.repositoryId, 'b1'.repeat(20))

    /*
     * The runner reaches this repository by scope and matches by label, and is
     * refused anyway - which is the entire reason pools exist. A machine bought
     * for one purpose does not take another repository's work because somebody
     * wrote the same label on it.
     */
    expect(await claimNextJob(runner)).toBeNull()

    // And once the pool serves it, the same runner takes the same job.
    await fleet({ operation: 'assign-repository', pool: poolId, repository: created.repositoryId })

    const claim = await claimNextJob(runner)

    expect(claim).not.toBeNull()
    expect(claim!.jobKey).toBe('build')
  }, 120_000)
})

describe('draining a queue', () => {
  test('stops new work without failing what is waiting, and resumes', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: unique('Drainable') })
    const poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: 'drainable-x64' })
    const queueId = Number(queue.body.queue.id)

    const runner = await makeRunner(created.repositoryId)

    await fleet({ operation: 'assign-runner', runner: runner.id, queue: queueId })

    const runId = await freshRun(created.repositoryId, 'b2'.repeat(20))

    await fleet({ operation: 'pause-queue', queue: queueId, reason: 'kernel upgrade' })

    expect(await claimNextJob(runner)).toBeNull()

    /*
     * Waiting, not failed. That is the difference between a drain and an
     * outage: the work is still there when the machines come back.
     */
    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['state'])
      .where('workflow_run_id', '=', runId)
      .executeTakeFirst()

    expect(String(job.state)).toBe('queued')

    // One call to undo it, which is what four in the afternoon needs.
    await fleet({ operation: 'resume-queue', queue: queueId })

    const claim = await claimNextJob(runner)

    expect(claim).not.toBeNull()
  }, 120_000)
})
