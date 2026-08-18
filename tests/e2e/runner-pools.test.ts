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
  noFleetToken: '',
  operatorToken: '',
  repositoryId: 0,
  otherRepositoryId: 0,
  handle: '',
  name: '',
  runnerIds: [] as number[],
  poolIds: [] as number[],
  runnerTokens: {} as Record<number, string>,
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
  const secret = unique('tok')

  const row: any = await db
    .insertInto('runners')
    .values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: repositoryId,
      token_hash: hashToken(secret),
      labels: 'ubuntu-latest',
      state: 'active',
    })
    .returning(['id'])
    .executeTakeFirst()

  created.runnerIds.push(Number(row.id))
  // Kept so a test can speak the protocol rather than only call the function
  // behind it: what a runner is *told* is the half that matters for stopping.
  created.runnerTokens[Number(row.id)] = secret

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

    const adminTokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'fleet test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    /*
     * `fleet: admin`, because being an instance administrator is no longer
     * enough on its own. The person check and the credential check are separate
     * questions - who is asking, and what are they holding - and a token issued
     * for one script should not reach the machines because its owner happens to
     * be an administrator.
     */
    await db.insertInto('access_token_permissions')
      .values({ access_token_id: Number(adminTokenRow?.id), scope: 'fleet', level: 'admin' })
      .execute()

    created.adminToken = token.token

    /*
     * Two narrower credentials for the same administrator, so the scope gate is
     * tested against somebody whose *person* check always passes. A test that
     * used a non-administrator would be re-testing the 404 above.
     */
    const narrower = async (level: string | null): Promise<string> => {
      const secret = generateToken()
      const row: any = await db.insertInto('access_tokens').values({
        user_id: created.ownerId,
        name: `fleet test ${level ?? 'none'}`,
        prefix: secret.prefix,
        token_hash: secret.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).returning(['id']).executeTakeFirst()

      // Something, so the token is not simply empty: this is a credential that
      // reaches code and is being asked about machines.
      await db.insertInto('access_token_permissions')
        .values({ access_token_id: Number(row?.id), scope: 'contents', level: 'admin' })
        .execute()

      if (level) {
        await db.insertInto('access_token_permissions')
          .values({ access_token_id: Number(row?.id), scope: 'fleet', level })
          .execute()
      }

      return secret.token
    }

    created.noFleetToken = await narrower(null)
    created.operatorToken = await narrower('write')

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

/*
 * Stopping a machine, which an autoscaler does far more often than a person
 * does. Both halves matter and they differ in one thing: what happens to the
 * job it is holding.
 */
describe('stopping a runner', () => {
  test('a graceful stop takes no new work, and the machine is told when it asks', async () => {
    if (!available)
      return

    const runner = await makeRunner(created.repositoryId)

    await freshRun(created.repositoryId, 'c1'.repeat(20))

    const { status, body } = await fleet({ operation: 'stop-runner', runner: runner.id })

    expect(status).toBe(200)
    expect(body.runner.stop).toBe('graceful')
    // Nothing was interrupted, because nothing was running.
    expect(body.returned).toBe(0)

    // No new work, even though a job is sitting right there for it.
    expect(await claimNextJob(runner)).toBeNull()

    /*
     * And the request is cleared once the machine has asked - a stop that
     * stayed set would stop it again the next time it started, which is how a
     * machine an operator brought back never comes back.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${created.runnerTokens[runner.id]}`, 'Content-Type': 'application/json', 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const claim = await answer.json()

    expect(claim.job).toBeNull()
    expect(claim.stop).toBe('graceful')

    const after: any = await db.selectFrom('runners').select(['stop_requested']).where('id', '=', runner.id).executeTakeFirst()

    expect(after.stop_requested).toBeNull()
  }, 120_000)

  test('a forced stop puts the job it was holding back in the queue, not in the bin', async () => {
    if (!available)
      return

    const runner = await makeRunner(created.repositoryId)

    await freshRun(created.repositoryId, 'c2'.repeat(20))

    const claim = await claimNextJob(runner)

    expect(claim).not.toBeNull()

    const { body } = await fleet({ operation: 'stop-runner', runner: runner.id, force: true })

    expect(body.runner.stop).toBe('forced')
    expect(body.returned).toBe(1)

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['state', 'runner_id', 'attempt', 'condition_reason'])
      .where('id', '=', claim!.jobId)
      .executeTakeFirst()

    /*
     * Queued, not cancelled. The work is fine; it is the machine that is going
     * away, and somebody watching a pull request should not see their build
     * fail because an autoscaler shrank the fleet.
     */
    expect(String(job.state)).toBe('queued')
    expect(job.runner_id).toBeNull()
    // Counted, so a machine force-stopped repeatedly cannot hand one job round
    // a fleet forever.
    expect(Number(job.attempt)).toBe(2)
    expect(String(job.condition_reason)).toContain('stopped')
  }, 120_000)
})

describe('the numbers an autoscaler polls', () => {
  test('are per queue, and are reported at zero rather than disappearing', async () => {
    if (!available)
      return

    const { collectFromDatabase, render, resetMetrics } = await import('../../app/Ops/metrics')

    resetMetrics()
    await collectFromDatabase()

    const text = render()

    /*
     * A gauge that disappears when it reaches zero is how a scaler concludes
     * there is no work, when what actually happened is that the series stopped
     * being reported.
     */
    expect(text).toContain('reviewos_ci_jobs_waiting')
    expect(text).toContain('reviewos_ci_runners')
    expect(text).toContain('lifecycle="idle"')
    expect(text).toContain('queue="unassigned"')

    // And the help text, because a metric nobody can interpret is one an
    // operator graphs wrong.
    expect(text).toContain('# HELP reviewos_ci_jobs_waiting')
  }, 120_000)
})

/*
 * Registration tokens: the credential a fleet machine should actually carry.
 *
 * Without them a scaler needs an administrator's token to create runners, which
 * puts the widest credential on the instance into a userdata blob on every
 * machine it starts.
 */
describe('registration tokens', () => {
  let poolId = 0
  let queueId = 0
  let tokenValue = ''
  let tokenId = 0

  async function register(token: string, body: Record<string, unknown> = {}): Promise<{ status: number, body: any }> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Runner-Protocol': '1',
      },
      body: JSON.stringify(body),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('a machine registers itself into the pool the token belongs to', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: unique('Registered') })
    poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: 'registered-x64' })
    queueId = Number(queue.body.queue.id)

    const minted = await fleet({ operation: 'create-token', pool: poolId, queue: queueId, name: 'us-east autoscaler' })

    expect(minted.status).toBe(200)
    tokenValue = String(minted.body.registration_token.token)
    tokenId = Number(minted.body.registration_token.id)

    const registered = await register(tokenValue, { name: 'build-07', labels: 'ubuntu-latest,self-hosted', tags: 'gpu=a100,region=ash' })

    expect(registered.status).toBe(201)
    expect(String(registered.body.runner.token)).not.toBe(tokenValue)

    created.runnerIds.push(Number(registered.body.runner.id))

    const row: any = await db
      .selectFrom('runners')
      .select(['runner_queue_id', 'tags', 'runner_registration_token_id'])
      .where('id', '=', Number(registered.body.runner.id))
      .executeTakeFirst()

    expect(Number(row.runner_queue_id)).toBe(queueId)
    expect(String(row.tags)).toContain('gpu=a100')
    // Which credential put this machine here, kept for after the token is
    // revoked - which is exactly when somebody asks.
    expect(Number(row.runner_registration_token_id)).toBe(tokenId)
  }, 120_000)

  test('the credential it registered with is not the credential it works with', async () => {
    if (!available)
      return

    /*
     * The threat model's rule made concrete: a registration credential must
     * never reach a job environment, and the only way to keep that promise is
     * for the thing running jobs to be holding something else by then.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenValue}`, 'Content-Type': 'application/json', 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    expect(answer.status).toBe(401)
  }, 60_000)

  test('first use and last use are recorded, because that is what anybody asks', async () => {
    if (!available)
      return

    const { body } = await fleet({ operation: 'list' })
    const pool = body.pools.find((entry: any) => Number(entry.id) === poolId)
    const token = pool.registration_tokens.find((entry: any) => Number(entry.id) === tokenId)

    expect(token.uses).toBe(1)
    expect(token.first_used_at).not.toBeNull()
    expect(token.revoked).toBe(false)
  }, 60_000)

  test('and a revoked one stops working, while the machines it made keep going', async () => {
    if (!available)
      return

    await fleet({ operation: 'revoke-token', token: tokenId })

    const refused = await register(tokenValue, { name: 'build-08' })

    expect(refused.status).toBe(401)

    /*
     * The machines it already registered are unaffected, and that is the
     * point of exchanging the credential: revoking the token stops *new*
     * machines joining, and does not interrupt a build that is running on one
     * that already did.
     */
    const runner = await runnerFacts(created.runnerIds[created.runnerIds.length - 1]!)

    expect(runner.state).toBe('active')
  }, 60_000)
})

/*
 * `agents:` - a tag query, which is a different question from a label.
 *
 * Labels are set membership, which is right for `ubuntu-latest` and wrong for
 * anything with a value in it: a fleet with four GPU models grows labels called
 * `gpu-a100`, and a label means whatever the person who typed it was thinking.
 */
describe('an impossible selector', () => {
  test('leaves the job queued with a visible reason rather than silently forever', async () => {
    if (!available)
      return

    const runner = await makeRunner(created.repositoryId)

    // The machine reports one tag; the job asks for another.
    await db.updateTable('runners').set({ tags: 'gpu=a10g' } as any).where('id', '=', runner.id).execute()

    const runId = await freshRun(created.repositoryId, 'd1'.repeat(20))

    await db
      .updateTable('workflow_jobs')
      .set({ settings: JSON.stringify({ agents: ['gpu=a100'] }) } as any)
      .where('workflow_run_id', '=', runId)
      .execute()

    expect(await claimNextJob(await runnerFacts(runner.id))).toBeNull()

    const { explainWaiting } = await import('../../app/Actions/Workflow/waiting')

    const explanation = explainWaiting(
      {
        id: 0,
        state: 'queued',
        runsOn: ['ubuntu-latest'],
        agents: ['gpu=a100'],
        repositoryId: created.repositoryId,
        ownerId: created.ownerId,
        runnerId: null,
        leaseExpiresAt: null,
      },
      [{ ...(await runnerFacts(runner.id)), tags: ['gpu=a10g'] }],
    )

    expect(explanation.kind).toBe('no-tags')
    // Both halves: what it asked for, and what the machines actually report.
    expect(explanation.summary).toContain('gpu=a100')
    expect(explanation.summary).toContain('gpu=a10g')
  }, 120_000)
})

describe('a pool maintainer', () => {
  test('can drain their own pool without administering the instance', async () => {
    if (!available)
      return

    const handle = unique('maint')

    const person: any = await db
      .insertInto('users')
      .values({ name: 'Fleet Maintainer', email: `${handle}@example.com`, handle, password: 'x', is_admin: false })
      .returning(['id'])
      .executeTakeFirst()

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    const maintainerToken: any = await db.insertInto('access_tokens').values({
      user_id: Number(person.id),
      name: 'maintainer',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    // A maintainer's credential needs the scope too. The role says which pools
    // they may touch; the scope says whether this particular token is for the
    // machines at all, and both have to agree.
    await db.insertInto('access_token_permissions')
      .values({ access_token_id: Number(maintainerToken?.id), scope: 'fleet', level: 'write' })
      .execute()

    const pool = await fleet({ operation: 'create-pool', name: unique('Owned') })
    const poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: 'owned-x64' })
    const queueId = Number(queue.body.queue.id)

    // Before being appointed, the endpoint does not exist for them.
    expect((await fleet({ operation: 'pause-queue', queue: queueId }, token.token)).status).toBe(404)

    await fleet({ operation: 'add-maintainer', pool: poolId, user: Number(person.id) })

    expect((await fleet({ operation: 'pause-queue', queue: queueId, reason: 'kernel upgrade' }, token.token)).status).toBe(200)

    /*
     * And not somebody else's pool. The existence of a pool they do not
     * maintain is not theirs to learn, so it is the same 404 a stranger gets.
     */
    const other = await fleet({ operation: 'create-pool', name: unique('Other') })
    const otherPool = Number(other.body.pool.id)
    created.poolIds.push(otherPool)

    const otherQueue = await fleet({ operation: 'create-queue', pool: otherPool, name: 'other-x64' })

    expect((await fleet({ operation: 'pause-queue', queue: Number(otherQueue.body.queue.id) }, token.token)).status).toBe(404)

    // Nor may they appoint themselves sideways into one: a role that can
    // appoint is not a narrower role at all.
    expect((await fleet({ operation: 'add-maintainer', pool: otherPool, user: Number(person.id) }, token.token)).status).toBe(404)

    await db.deleteFrom('users').where('id', '=', Number(person.id)).execute().catch(() => {})
  }, 120_000)
})

/*
 * The compiled runner registering itself, which is the flow the autoscaling
 * documentation tells people to use. Worth running rather than describing: the
 * usage text and the endpoint are in different files, and a flag that does not
 * reach the request is a cloud-init that fails at four in the morning.
 */
describe('the runner binary registering itself', () => {
  test('exchanges a registration token for its own credential', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: unique('Binary') })
    const poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    await fleet({ operation: 'create-queue', pool: poolId, name: 'binary-x64' })

    const minted = await fleet({ operation: 'create-token', pool: poolId, name: 'binary test' })
    const registration = String(minted.body.registration_token.token)

    const child = Bun.spawn([
      'bun',
      'app/Actions/Runner/standalone.ts',
      '--url',
      `http://127.0.0.1:${port}`,
      '--registration-token',
      registration,
      '--name',
      'binary-runner',
      '--tags',
      'gpu=a100',
      '--once',
    ], { stdout: 'pipe', stderr: 'pipe' })

    const [out, error] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(`${out}${error}`).toContain('Registered as')

    const row: any = await db
      .selectFrom('runners')
      .select(['id', 'tags', 'labels'])
      .where('name', '=', 'binary-runner')
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(row).toBeTruthy()
    created.runnerIds.push(Number(row.id))

    // The tags it reported about itself, which is what an `agents:` query
    // selects on - and the default labels, since it named none.
    expect(String(row.tags)).toContain('gpu=a100')
    expect(String(row.labels)).toContain('ubuntu-latest')
  }, 180_000)
})

/*
 * What the credential is for, after who is holding it.
 *
 * Every token here belongs to the same instance administrator, so the person
 * check passes every time and the only thing under test is the scope. Before
 * this gate existed, any token that administrator held - one issued to a
 * deployment script, carrying `contents` and nothing else - could create pools,
 * mint registration tokens and drain queues, because the fleet belongs to no
 * repository and no repository scope was ever consulted.
 */
describe('the fleet scope', () => {
  test('a token without it is refused, however administrative its owner', async () => {
    if (!available)
      return

    const { status, body } = await fleet({ operation: 'list' }, created.noFleetToken)

    // 403 rather than 404: this reader may see the fleet, so hiding it would be
    // a lie they can disprove by opening the page. What is missing is the
    // permission on this credential, and saying so is how they fix it.
    expect(status).toBe(403)
    expect(String(body?.error)).toContain('fleet')
    expect(String(body?.reason)).toContain('read')
  })

  test('write drains a queue and does not create a pool', async () => {
    if (!available)
      return

    const pool = await fleet({ operation: 'create-pool', name: unique('Scoped '), reason: 'for the scope test' })

    expect(pool.status).toBe(200)

    const poolId = Number(pool.body.pool.id)
    created.poolIds.push(poolId)

    const queue = await fleet({ operation: 'create-queue', pool: poolId, name: unique('queue-') })

    expect(queue.status).toBe(200)

    const queueId = Number(queue.body.queue.id)

    // The day the machines misbehave: an operator's token pauses the queue.
    const paused = await fleet({ operation: 'pause-queue', queue: queueId }, created.operatorToken)

    expect(paused.status).toBe(200)
    expect(String(paused.body?.queue?.state)).toBe('paused')

    // And the boundary work stays out of reach: drawing a new pool, or
    // appointing who may manage one, is not the same power as draining.
    const drawing = await fleet({ operation: 'create-pool', name: unique('Refused '), reason: 'should not exist' }, created.operatorToken)

    expect(drawing.status).toBe(403)
    expect(String(drawing.body?.reason)).toContain('admin')

    await fleet({ operation: 'resume-queue', queue: queueId }, created.operatorToken)
  })
})
