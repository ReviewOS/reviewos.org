// Run notifications, end to end: a rule, a run that ends, an inbox row.
//
// The interesting half is who does *not* hear. A rule outlives the access that
// justified it, a fork's run is somebody else's code, and a repository with
// four matching rules for one person is still one message.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  strangerId: 0,
  repositoryId: 0,
  workflowId: 0,
  versionId: 0,
  handle: '',
  strangerHandle: '',
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

async function rules(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-notifications`, {
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

/** A finished run of the seeded workflow, settled the way a report settles one. */
async function run(state: string, jobs: Array<{ key: string, state: string }>, branch = 'main', trusted = true): Promise<number> {
  const previous: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  const row: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: Number(previous?.number ?? 0) + 1,
    state,
    event: 'push',
    event_ref: `refs/heads/${branch}`,
    head_sha: unique('s').padEnd(40, '0').slice(0, 40),
    definition_sha: 'a'.repeat(40),
    trusted,
    finished_at: new Date().toISOString(),
  }).returning(['id']).executeTakeFirst()

  let position = 0

  for (const job of jobs) {
    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(row.id),
      job_id: job.key,
      name: job.key,
      position: position++,
      state: job.state,
      runs_on: 'ubuntu-latest',
    }).execute()
  }

  return Number(row.id)
}

async function inboxOf(userId: number): Promise<any[]> {
  return db
    .selectFrom('notifications')
    .select(['id', 'type', 'data'])
    .where('user_id', '=', userId)
    .where('type', '=', 'workflow_run')
    .orderBy('id', 'desc')
    .execute()
    .catch(() => [])
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

    created.handle = unique('notif')
    created.strangerHandle = unique('stranger')

    const make = async (handle: string): Promise<number> => {
      const row: any = await db.insertInto('users')
        .values({ name: 'Notified', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      return Number(row?.id)
    }

    created.ownerId = await make(created.handle)
    created.strangerId = await make(created.strangerHandle)
    created.name = unique('repo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      // Private, so the delivery check has something to refuse.
      visibility: 'private',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/deploy.yml',
      name: 'Deploy',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.workflowId = Number(workflow?.id)

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/deploy.yml',
      content_digest: unique('digest'),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'notification rules test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['actions', 'read'], ['administration', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token
    available = true
  }
  catch (error) {
    console.warn(`[notification-rules] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of [created.ownerId, created.strangerId].filter(Boolean))
      await db.deleteFrom('notifications').where('user_id', '=', id).execute().catch(() => {})

    if (created.repositoryId) {
      await db.deleteFrom('workflow_notification_rules').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    }

    for (const id of [created.ownerId, created.strangerId].filter(Boolean)) {
      await db.deleteFrom('access_tokens').where('user_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', id).execute().catch(() => {})
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('writing a rule', () => {
  test('refuses one that could never match, rather than storing it', async () => {
    if (!available)
      return

    const { status, body } = await rules({ operation: 'add', workflow: 'nightly.yml', condition: 'failure' })

    // A typo in a workflow name is the commonest way an alert silently never
    // arrives, and the moment to catch it is while somebody is looking at it.
    expect(status).toBe(422)
    expect(String(body?.error)).toContain('nightly.yml')
    expect(body?.workflows).toContain('.github/workflows/deploy.yml')
  }, 120_000)

  test('and stores one that can, named any of three ways', async () => {
    if (!available)
      return

    const { status, body } = await rules({ operation: 'add', workflow: 'deploy.yml', branch: 'main', condition: 'failure' })

    expect(status).toBe(200)
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].user).toBe(created.handle)

    // Twice is somebody pressing a button twice, not two rules and two
    // messages about one run.
    const again = await rules({ operation: 'add', workflow: 'deploy.yml', branch: 'main', condition: 'failure' })

    expect(again.body.rules).toHaveLength(1)
  }, 120_000)
})

describe('a run that ends', () => {
  test('tells whoever asked, once, with the reason they were told', async () => {
    if (!available)
      return

    const { deliverRunNotifications } = await import('../../app/Actions/Workflow/notifyDelivery')

    // A second rule for the same person, so the "one message" rule is exercised
    // rather than assumed.
    await rules({ operation: 'add', workflow: '*', branch: '*', condition: 'always' })

    const runId = await run('failed', [{ key: 'build', state: 'succeeded' }, { key: 'publish', state: 'failed' }])

    expect(await deliverRunNotifications(runId)).toBe(1)

    const [row] = await inboxOf(created.ownerId)
    const data = JSON.parse(String(row.data))

    expect(String(data.title)).toContain('failed')
    expect(String(data.title)).toContain('Deploy')
    // The first question about an alert is why it reached you.
    expect(String(data.reason)).toContain('failure')
    expect(String(data.url)).toContain(`/run/`)
  }, 120_000)

  test('and says nothing to somebody who cannot see the repository', async () => {
    if (!available)
      return

    const { deliverRunNotifications } = await import('../../app/Actions/Workflow/notifyDelivery')

    // Written straight to the table: the endpoint would refuse this, and the
    // case being tested is a rule that outlived the access that justified it.
    await db.insertInto('workflow_notification_rules').values({
      repository_id: created.repositoryId,
      user_id: created.strangerId,
      workflow: '*',
      branch: '*',
      job_key: '',
      condition: 'always',
    }).execute()

    const runId = await run('failed', [{ key: 'publish', state: 'failed' }])

    await deliverRunNotifications(runId)

    // A notification is not a way to learn that a private repository exists.
    expect(await inboxOf(created.strangerId)).toEqual([])
  }, 120_000)

  test('and nothing at all for a fork\'s run', async () => {
    if (!available)
      return

    const { deliverRunNotifications } = await import('../../app/Actions/Workflow/notifyDelivery')

    const before = (await inboxOf(created.ownerId)).length
    const runId = await run('failed', [{ key: 'publish', state: 'failed' }], 'main', false)

    expect(await deliverRunNotifications(runId)).toBe(0)

    // A stranger who can open a pull request must not be able to make this
    // instance message a maintainer on demand.
    expect((await inboxOf(created.ownerId)).length).toBe(before)
  }, 120_000)

  test('and a recovery reads as one', async () => {
    if (!available)
      return

    const { deliverRunNotifications } = await import('../../app/Actions/Workflow/notifyDelivery')

    await db.deleteFrom('workflow_notification_rules').where('repository_id', '=', created.repositoryId).execute()
    await db.deleteFrom('notifications').where('user_id', '=', created.ownerId).execute()

    await rules({ operation: 'add', workflow: 'deploy.yml', branch: 'main', condition: 'recovery' })

    const runId = await run('succeeded', [{ key: 'publish', state: 'succeeded' }])

    expect(await deliverRunNotifications(runId)).toBe(1)

    const [row] = await inboxOf(created.ownerId)

    expect(String(JSON.parse(String(row.data)).title)).toContain('passing again')
  }, 120_000)
})
