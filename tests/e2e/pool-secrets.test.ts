// A secret that belongs to the machines rather than to the code.
//
// The case is a registry credential that exists because *these* runners are
// allowed to publish. Writing it into every repository that needs it is how one
// credential ends up in twenty places and is rotated in three - and a
// repository-scoped secret cannot say "only on the hardware that is allowed to
// use it" at all.
//
// So: set on the pool through the fleet endpoint, delivered at the claim to a
// job a machine in that pool took, and delivered nowhere else.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  adminToken: '',
  poolId: 0,
  otherPoolId: 0,
  runnerIds: [] as number[],
}

let available = false
let db: any = null
let server: any = null
let port = 0

const IN_POOL = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`
const LOOSE = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`

async function fleet(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/instance/fleet`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.adminToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Dispatch a run and take its job as the given machine. */
async function claimAs(token: string): Promise<any> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('c').padEnd(40, '0').slice(0, 40),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Runner-Protocol': '1' },
    body: '{}',
  })

  const body: any = await answer.json().catch(() => null)

  return body?.job ?? null
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

    created.handle = unique('psec')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Pool Secrets', email: `${created.handle}@example.com`, handle: created.handle, password: 'x', is_admin: true })
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
      name: 'pool secrets test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('access_token_permissions')
      .values({ access_token_id: Number(tokenRow?.id), scope: 'fleet', level: 'admin' })
      .execute()

    created.adminToken = secret.token

    const pool = await fleet({ operation: 'create-pool', name: unique('Publishers '), reason: 'machines allowed to publish' })
    created.poolId = Number(pool.body?.pool?.id)

    const other = await fleet({ operation: 'create-pool', name: unique('Builders ') })
    created.otherPoolId = Number(other.body?.pool?.id)

    const queue = await fleet({ operation: 'create-queue', pool: created.poolId, name: unique('publish-') })

    const runner: any = await db.insertInto('runners').values({
      name: unique('inpool'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      runner_queue_id: Number(queue.body?.queue?.id),
      token_hash: hashToken(IN_POOL),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerIds.push(Number(runner?.id))

    // A machine in no queue at all, which is what every installation had before
    // pools existed and is the case a pool secret must not leak into.
    const loose: any = await db.insertInto('runners').values({
      name: unique('loose'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(LOOSE),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerIds.push(Number(loose?.id))

    available = Boolean(created.poolId && created.otherPoolId)
  }
  catch (error) {
    console.warn(`[pool-secrets] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    await db.deleteFrom('workflow_secrets').where('scope_type', '=', 'pool').where('scope_id', 'in', [created.poolId, created.otherPoolId].filter(Boolean)).execute().catch(() => {})

    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute().catch(() => {})

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    for (const id of [created.poolId, created.otherPoolId].filter(Boolean))
      await db.deleteFrom('runner_pools').where('id', '=', id).execute().catch(() => {})

    if (created.ownerId) {
      await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('setting one', () => {
  test('stores it sealed, and lists the name without the value', async () => {
    if (!available)
      return

    const { status, body } = await fleet({
      operation: 'set-secret',
      pool: created.poolId,
      key: 'REGISTRY_TOKEN',
      value: 'the-value-only-these-machines-get',
    })

    expect(status).toBe(200)
    expect(body.secrets.map((one: any) => one.key)).toEqual(['REGISTRY_TOKEN'])
    // The answer says the name and never the value, like every other secret
    // surface here.
    expect(JSON.stringify(body)).not.toContain('the-value-only-these-machines-get')

    const row: any = await db
      .selectFrom('workflow_secrets')
      .select(['sealed'])
      .where('scope_type', '=', 'pool')
      .where('scope_id', '=', created.poolId)
      .where('key', '=', 'REGISTRY_TOKEN')
      .executeTakeFirst()

    expect(row).toBeTruthy()
    expect(String(row.sealed)).not.toContain('the-value-only-these-machines-get')
  }, 120_000)

  test('and writes an audit row naming the pool and the key, never the value', async () => {
    if (!available)
      return

    const rows = await db
      .selectFrom('audit_events')
      .select(['action', 'detail'])
      .where('action', '=', 'fleet:secret-written')
      .orderBy('id', 'desc')
      .limit(5)
      .execute()

    const mine = rows.find((one: any) => String(one.detail ?? '').includes(String(created.poolId)))

    expect(mine).toBeTruthy()
    expect(String(mine.detail)).toContain('REGISTRY_TOKEN')
    expect(String(mine.detail)).not.toContain('the-value-only-these-machines-get')
  }, 120_000)
})

describe('delivery', () => {
  test('reaches a job a machine in the pool took', async () => {
    if (!available)
      return

    const job = await claimAs(IN_POOL)

    expect(job).toBeTruthy()
    expect(job.secrets?.REGISTRY_TOKEN).toBe('the-value-only-these-machines-get')
  }, 120_000)

  test('and not a job on a machine in no pool', async () => {
    if (!available)
      return

    const job = await claimAs(LOOSE)

    expect(job).toBeTruthy()
    // The safe direction: the credential exists because those machines are
    // trusted with it, and this one is not in the pool at all.
    expect(job.secrets?.REGISTRY_TOKEN).toBeUndefined()
  }, 120_000)

  test('and not a job on another pool\'s machines', async () => {
    if (!available)
      return

    await fleet({ operation: 'set-secret', pool: created.otherPoolId, key: 'OTHER_TOKEN', value: 'somebody-elses' })

    const job = await claimAs(IN_POOL)

    expect(job.secrets?.REGISTRY_TOKEN).toBe('the-value-only-these-machines-get')
    expect(job.secrets?.OTHER_TOKEN).toBeUndefined()
  }, 120_000)

  test('and stops arriving once it is removed', async () => {
    if (!available)
      return

    const { status, body } = await fleet({ operation: 'unset-secret', pool: created.poolId, key: 'REGISTRY_TOKEN' })

    expect(status).toBe(200)
    expect(body.secrets).toEqual([])

    const job = await claimAs(IN_POOL)

    expect(job.secrets?.REGISTRY_TOKEN).toBeUndefined()
  }, 120_000)
})
