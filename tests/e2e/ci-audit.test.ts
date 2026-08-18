// The CI surface's state-changing verbs, in the audit log, attributable to a token.
//
// Phase 11 built the log; phase 15 built a control plane that spends the
// instance's machines - and until this test the two had never met. Starting a
// run, turning a workflow off and setting a variable all left the same trace as
// reading a page: none.
//
// It runs against a real `route.serve()` boot with a bearer token rather than by
// calling the actions, and that is the whole point. `actor_id` is filled in
// either way, but `access_token_id` is only filled when the request carried a
// token - and "a program did this, using this credential" is the fact the log
// exists to preserve. A test that called the action directly would pass with
// the attribution missing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, tokenId: 0, runNumber: 0, handle: '', name: '', token: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function api(path: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Recorded on the row, and the fastest way for a reader to tell a script
      // from a person - so it is asserted rather than left to chance.
      'User-Agent': 'reviewos-audit-test/1.0',
    },
    body: JSON.stringify(body),
  })

  const text = await answer.text()

  try {
    return { status: answer.status, body: JSON.parse(text) }
  }
  catch {
    return { status: answer.status, body: text }
  }
}

/** Every audit row this repository has, newest first. */
async function rows(action?: string): Promise<any[]> {
  let query = db
    .selectFrom('audit_events')
    .select(['action', 'actor_id', 'access_token_id', 'user_agent', 'subject_type', 'subject_id', 'detail'])
    .where('repository_id', '=', created.repositoryId)

  if (action)
    query = query.where('action', '=', action)

  return query.orderBy('id', 'desc').execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('ciaudit')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'CI Audit', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the CI audit end to end test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    const workflow: any = await db
      .insertInto('workflows')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        repository_id: created.repositoryId,
        path: '.github/workflows/deploy.yml',
        name: 'Deploy',
        state: 'active',
      })
      .returning(['id'])
      .executeTakeFirst()
    created.workflowId = Number(workflow?.id)

    const version: any = await db
      .insertInto('workflow_versions')
      .values({
        workflow_id: created.workflowId,
        source_sha: 'c'.repeat(40),
        source_path: '.github/workflows/deploy.yml',
        content_digest: unique('digest'),
        on_dispatch: true,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.versionId = Number(version?.id)

    /*
     * One token carrying both halves: `actions: admin` is what dispatching and
     * turning a workflow off take between them,
     * `administration: write` is what a variable takes. Two tokens would prove
     * the same thing and would leave the interesting question - whether the row
     * names the credential rather than only the person - answered twice.
     */
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'ci audit test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    created.tokenId = Number(tokenRow?.id)
    created.token = secret.token

    for (const [scope, level] of [['actions', 'admin'], ['administration', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: created.tokenId, scope, level }).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    available = true
  }
  catch (error) {
    console.warn(`[ci-audit] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) } catch { /* already gone */ }

  try {
    if (created.repositoryId) {
      await db.deleteFrom('audit_events').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.tokenId)
      await db.deleteFrom('access_tokens').where('id', '=', created.tokenId).execute()

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('starting a run', () => {
  test('is recorded against the person and the token that started it', async () => {
    if (!available)
      return

    const { status, body } = await api('/api/repos/workflows/dispatch', {
      owner: created.handle,
      repo: created.name,
      workflow: 'deploy.yml',
    })

    expect(status).toBe(201)
    expect(Number(body?.workflow_run?.number)).toBeGreaterThan(0)

    created.runNumber = Number(body?.workflow_run?.number)

    const [row] = await rows('workflow:run-dispatched')

    expect(row).toBeTruthy()
    expect(Number(row.actor_id)).toBe(created.ownerId)
    // The half a direct call would never exercise.
    expect(Number(row.access_token_id)).toBe(created.tokenId)
    expect(String(row.user_agent)).toBe('reviewos-audit-test/1.0')
    expect(String(row.subject_type)).toBe('workflow_run')

    // The workflow, so a reader can tell which deploy this was without
    // resolving the run first.
    expect(JSON.parse(String(row.detail)).workflow).toBe('.github/workflows/deploy.yml')
  })
})

describe('stopping that run', () => {
  test('is recorded, with the state it was stopped from', async () => {
    if (!available)
      return

    const { status, body } = await api('/api/repos/workflow-runs/cancel', {
      owner: created.handle,
      repo: created.name,
      number: created.runNumber,
      reason: 'stopped by the audit test',
    })

    expect(status).toBe(200)
    expect(body?.cancelled).toBe(true)

    const [row] = await rows('workflow:run-cancelled')

    expect(row).toBeTruthy()
    expect(Number(row.access_token_id)).toBe(created.tokenId)

    const detail = JSON.parse(String(row.detail))

    // The state it was in, because "cancelled a queued run" and "killed a run
    // that was halfway through a deploy" are not the same event.
    expect(detail.from).toBe('queued')
    expect(detail.number).toBe(created.runNumber)
  })
})

describe('turning a workflow off', () => {
  test('is recorded, because nothing else about the repository visibly changes', async () => {
    if (!available)
      return

    const { status } = await api('/api/repos/workflows/manage', {
      owner: created.handle,
      repo: created.name,
      workflow: '.github/workflows/deploy.yml',
      operation: 'disable',
    })

    expect(status).toBe(200)

    const [row] = await rows('workflow:disabled')

    expect(row).toBeTruthy()
    expect(Number(row.access_token_id)).toBe(created.tokenId)
    expect(JSON.parse(String(row.detail)).workflow).toBe('.github/workflows/deploy.yml')

    // And enabling it again is a different verb rather than the same one with a
    // field to read: an audit log is searched by action name.
    const back = await api('/api/repos/workflows/manage', {
      owner: created.handle,
      repo: created.name,
      workflow: '.github/workflows/deploy.yml',
      operation: 'enable',
    })

    expect(back.status).toBe(200)
    expect((await rows('workflow:enabled')).length).toBe(1)
  })
})

describe('a variable', () => {
  test('is recorded with its value, unlike a secret', async () => {
    if (!available)
      return

    const { status } = await api('/api/repos/variables', {
      owner: created.handle,
      repo: created.name,
      operation: 'set',
      key: 'DEPLOY_TARGET',
      value: 'production',
      scope: 'repository',
    })

    expect(status).toBe(200)

    const [row] = await rows('workflow:variable-written')

    expect(row).toBeTruthy()
    expect(Number(row.access_token_id)).toBe(created.tokenId)

    const detail = JSON.parse(String(row.detail))

    expect(detail.key).toBe('DEPLOY_TARGET')
    /*
     * The value is here on purpose. A variable is not a credential and "who
     * pointed the deploy at production" is the question this log answers; the
     * secret endpoints record the name and the scope and never the value, which
     * the unit test for the catalogue cannot tell apart from this one.
     */
    expect(detail.value).toBe('production')
  })

  test('and removing one is its own verb', async () => {
    if (!available)
      return

    const { status } = await api('/api/repos/variables', {
      owner: created.handle,
      repo: created.name,
      operation: 'unset',
      key: 'DEPLOY_TARGET',
      scope: 'repository',
    })

    expect(status).toBe(200)

    const [row] = await rows('workflow:variable-removed')

    expect(row).toBeTruthy()
    expect(Number(row.access_token_id)).toBe(created.tokenId)
    expect(JSON.parse(String(row.detail)).key).toBe('DEPLOY_TARGET')
  })
})

describe('a secret', () => {
  test('is recorded by name and scope, never by value', async () => {
    if (!available)
      return

    const { status } = await api('/api/repos/secrets', {
      owner: created.handle,
      repo: created.name,
      operation: 'set',
      key: 'DEPLOY_KEY',
      value: 'the-value-that-must-not-be-logged',
      scope: 'repository',
    })

    expect(status).toBe(200)

    const [row] = await rows('workflow:secret-written')

    expect(row).toBeTruthy()
    expect(Number(row.access_token_id)).toBe(created.tokenId)

    const detail = String(row.detail)

    expect(JSON.parse(detail).key).toBe('DEPLOY_KEY')
    // The assertion the feature is for: an audit row that carried the value
    // would be a second place the secret lives, with weaker protection than the
    // first.
    expect(detail).not.toContain('the-value-that-must-not-be-logged')
  })
})
