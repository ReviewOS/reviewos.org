// Preview environments: a link on a pull request that stops being a link when
// the pull request ends.
//
// A preview is a deployment with a pull request on it - not a second model,
// which is what makes expiry a fact rather than a feature: the thing it belongs
// to closed, so it is no longer current. The two cases worth testing are the
// ones that cost money and confusion respectively: a preview nobody expires,
// and five previews for one branch of which four point at nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, pullRequestId: 0, handle: '', name: '', token: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function deployments(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/deployments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
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

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('prev')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Previews', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const pull: any = await db.insertInto('pull_requests').values({
      repository_id: created.repositoryId,
      number: 1,
      title: 'A change worth looking at',
      author_id: created.ownerId,
      state: 'open',
      base_branch: 'main',
      head_branch: 'feature',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
    }).returning(['id']).executeTakeFirst()

    created.pullRequestId = Number(pull?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'previews test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['actions', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token
    available = true
  }
  catch (error) {
    console.warn(`[previews] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.repositoryId) {
      await db.deleteFrom('deployment_statuses').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('deployments').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    }

    if (created.ownerId) {
      await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('a preview', () => {
  test('is recorded against the pull request, and shows on it', async () => {
    if (!available)
      return

    const { status, body } = await deployments({
      operation: 'create',
      environment: 'preview',
      sha: 'a'.repeat(40),
      ref: 'refs/heads/feature',
      url: 'https://pr-1.preview.example',
      state: 'active',
      pull_request: created.pullRequestId,
    })

    expect(status).toBe(200)
    expect(Number(body?.deployment?.id)).toBeGreaterThan(0)

    const { previewsFor } = await import('../../app/Actions/Deploy/previews')
    const links = await previewsFor(created.pullRequestId)

    expect(links).toHaveLength(1)
    expect(links[0]!.url).toBe('https://pr-1.preview.example')

    const page = await (await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1`)).text()

    expect(page).toContain('https://pr-1.preview.example')
  }, 180_000)

  test('and a second push replaces the first rather than adding to it', async () => {
    if (!available)
      return

    await deployments({
      operation: 'create',
      environment: 'preview',
      sha: 'c'.repeat(40),
      url: 'https://pr-1-second.preview.example',
      state: 'active',
      pull_request: created.pullRequestId,
    })

    const { previewsFor } = await import('../../app/Actions/Deploy/previews')
    const links = await previewsFor(created.pullRequestId)

    // A branch pushed to five times would otherwise have five live previews,
    // four of them pointing at URLs that no longer answer - and the page would
    // show whichever the query ordered first.
    expect(links).toHaveLength(1)
    expect(links[0]!.url).toBe('https://pr-1-second.preview.example')

    const rows = await db
      .selectFrom('deployments')
      .select(['state', 'reason'])
      .where('pull_request_id', '=', created.pullRequestId)
      .orderBy('id')
      .execute()

    // The first is inactive rather than gone: what was on this URL last
    // Tuesday is a question somebody asks.
    expect(String(rows[0].state)).toBe('inactive')
    expect(String(rows[0].reason)).toContain('replaced')
  }, 180_000)

  test('and expires when the pull request ends, saying which way it ended', async () => {
    if (!available)
      return

    const { default: listener } = await import('../../app/Listeners/ExpirePreviews')

    await db.updateTable('pull_requests')
      .set({ state: 'merged', merged_at: new Date().toISOString() })
      .where('id', '=', created.pullRequestId)
      .execute()

    await listener.handle({ repositoryId: created.repositoryId, subjectId: created.pullRequestId })

    const { previewsFor } = await import('../../app/Actions/Deploy/previews')

    expect(await previewsFor(created.pullRequestId)).toEqual([])

    const row: any = await db
      .selectFrom('deployments')
      .select(['state', 'reason', 'finished_at'])
      .where('pull_request_id', '=', created.pullRequestId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(String(row.state)).toBe('inactive')
    // Merged and closed mean different things to whoever reads the history:
    // one shipped, the other did not.
    expect(String(row.reason)).toContain('merged')
    expect(row.finished_at).toBeTruthy()

    const page = await (await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/pull/1`)).text()

    expect(page).not.toContain('https://pr-1-second.preview.example')
  }, 180_000)

  test('and one recorded after the merge does not stay live', async () => {
    if (!available)
      return

    // The ordinary case rather than the rare one: a slow deploy finishing after
    // the pull request merged would otherwise leave a preview live forever.
    await deployments({
      operation: 'create',
      environment: 'preview',
      sha: 'd'.repeat(40),
      url: 'https://pr-1-late.preview.example',
      state: 'active',
      pull_request: created.pullRequestId,
    })

    const { previewsFor } = await import('../../app/Actions/Deploy/previews')

    expect(await previewsFor(created.pullRequestId)).toEqual([])
  }, 180_000)
})

describe('the history', () => {
  test('keeps every deployment, with what happened to it', async () => {
    if (!available)
      return

    await deployments({ operation: 'create', environment: 'production', sha: 'e'.repeat(40), state: 'active', url: 'https://example.test' })

    const { body } = await deployments({ operation: 'list', environment: 'production' })

    expect(body.deployments).toHaveLength(1)
    expect(body.deployments[0].environment).toBe('production')
    expect(body.deployments[0].url).toBe('https://example.test')
  }, 180_000)

  test('and records who said production moved', async () => {
    if (!available)
      return

    const rows = await db
      .selectFrom('audit_events')
      .select(['action', 'actor_id', 'access_token_id', 'detail'])
      .where('repository_id', '=', created.repositoryId)
      .where('action', '=', 'deployment:recorded')
      .orderBy('id', 'desc')
      .limit(1)
      .execute()

    expect(rows).toHaveLength(1)
    // "Who said production was on this commit" is the question an incident asks
    // first, and a program answering it needs the token as well as the person.
    expect(Number(rows[0].actor_id)).toBe(created.ownerId)
    expect(Number(rows[0].access_token_id)).toBeGreaterThan(0)
  }, 180_000)
})

/*
 * How a deployment got where it is, and putting an earlier one back.
 *
 * The deployment row carries where it got to; a column that overwrites itself
 * keeps one fact out of four, and the one it keeps is never the one being asked
 * about - which is always "when did it go down, and what did the job say".
 */
describe('a deployment\'s history', () => {
  test('records each state it passed through, not only the last', async () => {
    if (!available)
      return

    const made = await deployments({
      operation: 'create',
      environment: 'staging',
      sha: 'f'.repeat(40),
      state: 'in_progress',
      url: 'https://staging.test',
      description: 'the job started',
    })

    const id = Number(made.body.deployment.id)

    await deployments({ operation: 'update', id, state: 'failed', description: 'the health check never passed' })
    await deployments({ operation: 'update', id, state: 'active', description: 'the retry worked' })

    const { body } = await deployments({ operation: 'history', id })

    // Oldest first, which is the order it happened in.
    expect(body.statuses.map((one: any) => one.state)).toEqual(['in_progress', 'failed', 'active'])
    expect(String(body.statuses[1].description)).toContain('health check')
  }, 180_000)

  test('and a rollback is a new deployment that names what it restored', async () => {
    if (!available)
      return

    const first = await deployments({
      operation: 'create',
      environment: 'production',
      sha: '1'.repeat(40),
      state: 'active',
      url: 'https://one.test',
    })

    const older = Number(first.body.deployment.id)

    await deployments({
      operation: 'create',
      environment: 'production',
      sha: '2'.repeat(40),
      state: 'active',
      url: 'https://two.test',
    })

    const back = await deployments({ operation: 'rollback', id: older })

    expect(back.status).toBe(200)
    expect(Number(back.body.deployment.restored)).toBe(older)

    /*
     * A new row rather than the old one revived, because that is what happened:
     * something was deployed today and it happens to be what was deployed
     * before. Reviving would leave a history in which the older deployment ran
     * for a week with a gap in the middle, which is not a thing that occurred.
     */
    expect(Number(back.body.deployment.id)).not.toBe(older)

    const { body } = await deployments({ operation: 'history', id: Number(back.body.deployment.id) })
    const rolled = body.statuses.find((one: any) => one.state === 'rolled_back')

    expect(rolled).toBeTruthy()
    // The version restored is a column rather than a sentence somebody wrote
    // into a description and hoped to parse later.
    expect(Number(rolled.restored)).toBe(older)

    // And only one deployment of that environment is live, because two is a
    // listing that cannot say what is running.
    const live = await deployments({ operation: 'list', environment: 'production' })
    const active = live.body.deployments.filter((one: any) => one.state === 'active')

    expect(active).toHaveLength(1)
    expect(Number(active[0].id)).toBe(Number(back.body.deployment.id))
  }, 180_000)

  test('and programs are told, with the state in `action`', async () => {
    if (!available)
      return

    const seen: any[] = []
    const { emitter } = await import('@stacksjs/events')
    const listener = (payload: any): void => { seen.push(payload) }

    emitter.on('deployment:status' as any, listener as any)

    try {
      await deployments({
        operation: 'create',
        environment: 'announced',
        sha: '3'.repeat(40),
        state: 'active',
        url: 'https://announced.test',
      })

      const told = seen.find(one => String(one?.deployment?.environment) === 'announced')

      expect(told).toBeTruthy()
      expect(String(told.action)).toBe('active')
      expect(String(told.deployment.url)).toBe('https://announced.test')
    }
    finally {
      emitter.off('deployment:status' as any, listener as any)
    }
  }, 180_000)
})
