// The cache endpoints, driven the way a runner drives them.
//
// The other cache tests hold the rules and the storage. These hold the two
// things only the HTTP surface can be wrong about: that a runner cannot talk
// the instance into writing somewhere it should not, and that a cold cache
// answers with "nothing here" rather than with an error a job would fail on.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runnerId: 0, keys: [] as string[] }

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`
const SNAPSHOT = 'a tar of node_modules, as far as this test is concerned'

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

function key(): string {
  const one = unique('k').padEnd(64, '0').slice(0, 64)
  created.keys.push(one)

  return one
}

async function digestOf(text: string): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(hashed)].map(one => one.toString(16).padStart(2, '0')).join('')
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
`

/** Claim a job and keep the credential it was handed. */
async function claimOne(): Promise<string> {
  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: `${Math.random().toString(16).slice(2)}`.padEnd(40, '0'),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: '{}',
  })

  const body: any = await answer.json()

  return String(body.job.token)
}

async function save(token: string, cacheKey: string, body: string, extra: Record<string, string> = {}) {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/caches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Cache-Key': cacheKey,
      'X-Cache-Digest': await digestOf(body),
      ...extra,
    },
    body,
  })

  return { status: answer.status, body: await answer.json().catch(() => ({})) as any }
}

async function restore(token: string, cacheKey: string) {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/caches/restore`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-Cache-Key': cacheKey },
  })

  return {
    status: answer.status,
    scope: answer.headers.get('x-cache-scope'),
    exact: answer.headers.get('x-cache-exact'),
    text: answer.status === 200 ? await answer.text() : '',
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_cache_entries').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('cch')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Caches', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    created.runnerId = Number(runner.id)

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
    console.warn(`[runner-caches] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('saving and restoring', () => {
  test('the body is the archive, and it comes back byte for byte', async () => {
    if (!available)
      return

    const token = await claimOne()
    const cacheKey = key()

    const saved = await save(token, cacheKey, SNAPSHOT)

    expect(saved.status).toBe(201)
    // The scope is the run's own, worked out on the instance rather than sent.
    expect(saved.body.scope).toBe('refs/heads/main')

    const got = await restore(token, cacheKey)

    expect(got.status).toBe(200)
    expect(got.text).toBe(SNAPSHOT)
    expect(got.scope).toBe('refs/heads/main')
    expect(got.exact).toBe('true')
  }, 120_000)

  /**
   * A cold cache is not an error. It is what the first run after a lockfile
   * change looks like, and a runner treating it as one would fail a job over a
   * cache miss.
   */
  test('a key nothing was stored under is 204, not 404', async () => {
    if (!available)
      return

    const got = await restore(await claimOne(), key())

    expect(got.status).toBe(204)
    expect(got.text).toBe('')
  }, 120_000)

  test('the same snapshot sent twice is answered as done', async () => {
    if (!available)
      return

    // At-least-once delivery: a runner that did not hear the answer sends it
    // again, and a conflict here would make a correct runner retry forever.
    const token = await claimOne()
    const cacheKey = key()

    expect((await save(token, cacheKey, SNAPSHOT)).status).toBe(201)

    const again = await save(token, cacheKey, SNAPSHOT)

    expect(again.status).toBe(200)
    expect(again.body.duplicate).toBe(true)
  }, 120_000)
})

describe('what a runner cannot talk the instance into', () => {
  test('writing to a scope other than the one its run has', async () => {
    if (!available)
      return

    /*
     * This run is trusted and on `main`, so naming `main` is allowed and naming
     * anything else is not. The point is that the header is checked rather than
     * used: a runner is somebody else's program, and a boundary that reads its
     * inputs from the party it protects against is decoration.
     */
    const token = await claimOne()
    const refused = await save(token, key(), SNAPSHOT, { 'X-Cache-Scope': 'refs/heads/somebody-elses-branch' })

    expect(refused.status).toBe(403)
    expect(String(refused.body.error)).toContain('refs/heads/main')
  }, 120_000)

  test('saving or restoring with no job credential at all', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/runner/caches/restore`, {
      headers: { 'X-Cache-Key': key() },
    })

    expect(answer.status).toBe(401)
  }, 120_000)

  test('a body with no key, and a body that is not there', async () => {
    if (!available)
      return

    const token = await claimOne()

    const noKey = await fetch(`http://127.0.0.1:${port}/api/runner/caches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: SNAPSHOT,
    })

    expect(noKey.status).toBe(422)

    const noBody = await save(token, key(), '')

    expect(noBody.status).toBe(422)
  }, 120_000)
})
