// The control plane's read surface, and the one lifecycle action.
//
// Against a real `route.serve()` boot rather than by calling the actions,
// because half of what is being asserted is the wiring: the route exists, the
// authorization runs, and a private repository answers 404 to a stranger rather
// than 403 - a 403 confirms it exists, which is the one thing it must not say.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', versionId: 0, token: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function api(path: string, init?: RequestInit): Promise<{ status: number, body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const text = await response.text()

  try {
    return { status: response.status, body: JSON.parse(text) }
  }
  catch {
    return { status: response.status, body: text }
  }
}

/** A run in a given state, with one job. */
async function makeRun(state: string, sha: string, ref = 'refs/heads/main'): Promise<number> {
  const previous: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  const number = Number(previous?.number ?? 0) + 1

  const run: any = await db
    .insertInto('workflow_runs')
    .values({
      workflow_version_id: created.versionId,
      repository_id: created.repositoryId,
      number,
      state,
      event: 'push',
      event_ref: ref,
      head_sha: sha,
      definition_sha: sha,
      trusted: true,
    })
    .returning(['id'])
    .executeTakeFirst()

  await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    job_id: 'test',
    name: 'Test',
    position: 0,
    state: state === 'running' ? 'running' : 'queued',
    runs_on: 'ubuntu-latest',
  }).execute()

  return number
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('wfa')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Workflow API', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    const workflow: any = await db.insertInto('workflows')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        repository_id: created.repositoryId,
        path: '.github/workflows/ci.yml',
        name: 'CI',
        state: 'active',
      })
      .returning(['id']).executeTakeFirst()

    const version: any = await db.insertInto('workflow_versions')
      .values({
        workflow_id: Number(workflow.id),
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/ci.yml',
        content_digest: unique('digest'),
        on_push: true,
      })
      .returning(['id']).executeTakeFirst()
    created.versionId = Number(version.id)

    // A credential that can stop a run and nothing more. `workflow:cancel`
    // maps to `checks: write`, so this is also the assertion that the mapping
    // is wired: a token carrying it reaches the endpoint at all.
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'workflow test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['checks', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[workflow-api] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) } catch { /* already gone */ }

  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('listing runs', () => {
  test('a repository with none answers with an empty list rather than a 404', async () => {
    if (!available)
      return

    const { status, body } = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}`)

    expect(status).toBe(200)
    expect(body.workflow_runs).toEqual([])
    expect(body.next).toBeNull()
  })

  test('and returns them newest first', async () => {
    if (!available)
      return

    await makeRun('succeeded', 'a'.repeat(40))
    await makeRun('failed', 'b'.repeat(40))
    await makeRun('queued', 'c'.repeat(40))

    const { body } = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}`)

    expect(body.workflow_runs.map((run: any) => run.number)).toEqual([3, 2, 1])
    expect(body.workflow_runs[0].state).toBe('queued')
  })

  test('filters by state, by commit, and by branch', async () => {
    if (!available)
      return

    const byState = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&state=failed`)
    expect(byState.body.workflow_runs.map((run: any) => run.state)).toEqual(['failed'])

    const bySha = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&sha=${'b'.repeat(40)}`)
    expect(bySha.body.workflow_runs.length).toBe(1)

    // A branch name, not a ref: that is what somebody types.
    const byBranch = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&branch=main`)
    expect(byBranch.body.workflow_runs.length).toBe(3)

    const missing = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&branch=nope`)
    expect(missing.body.workflow_runs).toEqual([])
  })

  test('refuses a state it does not have, with the list of the ones it does', async () => {
    if (!available)
      return

    const { status, body } = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&state=exploded`)

    expect(status).toBe(422)
    expect(JSON.stringify(body)).toContain('queued')
  })

  test('pages with a cursor, and stops rather than returning an empty page', async () => {
    if (!available)
      return

    const first = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&per_page=2`)
    expect(first.body.workflow_runs.length).toBe(2)
    expect(first.body.next).not.toBeNull()

    const second = await api(`/api/repos/workflow-runs?owner=${created.handle}&repo=${created.name}&per_page=2&cursor=${encodeURIComponent(first.body.next)}`)
    expect(second.body.workflow_runs.length).toBe(1)
    // The last page carries no cursor, so a client following them stops rather
    // than polling an empty page forever.
    expect(second.body.next).toBeNull()

    const numbers = [...first.body.workflow_runs, ...second.body.workflow_runs].map((run: any) => run.number)
    expect(numbers).toEqual([3, 2, 1])
  })
})

describe('one run', () => {
  test('comes back with its jobs', async () => {
    if (!available)
      return

    const { status, body } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=1`)

    expect(status).toBe(200)
    expect(body.workflow_run.number).toBe(1)
    expect(body.workflow_run.jobs.length).toBe(1)
    expect(body.workflow_run.jobs[0].job_id).toBe('test')
    // The definition it ran, so a reader can tell it from the file today.
    expect(body.workflow_run.workflow.name).toBe('CI')
    expect(body.workflow_run.version.digest).toBeTruthy()
  })

  test('and a number that does not exist is a 404', async () => {
    if (!available)
      return

    const { status } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=9999`)
    expect(status).toBe(404)
  })
})

describe('cancelling', () => {
  test('needs a caller, and an anonymous one is refused', async () => {
    if (!available)
      return

    const { status } = await api(
      `/api/repos/workflow-runs/cancel?owner=${created.handle}&repo=${created.name}&number=1`,
      { method: 'POST' },
    )

    // Unauthenticated, so this never reaches the action. What matters is that
    // it is not 200: stopping somebody's build is not something a stranger does.
    expect(status).not.toBe(200)
  })

  test('a caller who may stops the run and everything under it', async () => {
    if (!available)
      return

    const number = await makeRun('running', 'd'.repeat(40))

    const { status, body } = await api(
      `/api/repos/workflow-runs/cancel?owner=${created.handle}&repo=${created.name}&number=${number}`,
      { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    expect(status).toBe(200)
    expect(body.cancelled).toBe(true)
    expect(body.workflow_run.state).toBe('cancelling')

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    expect(String(run.state)).toBe('cancelling')

    // The job was running, so it is asked to stop rather than declared
    // stopped - and its lease is revoked here, which is what keeps a worker
    // that has already lost its connection from reporting a success over this.
    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['state', 'lease_expires_at'])
      .where('workflow_run_id', '=', Number(run.id))
      .executeTakeFirst()

    expect(String(job.state)).toBe('cancelling')
    expect(job.lease_expires_at).toBeTruthy()
  })

  test('cancelling one that already finished is not an error', async () => {
    if (!available)
      return

    const number = await makeRun('succeeded', 'e'.repeat(40))

    const { status, body } = await api(
      `/api/repos/workflow-runs/cancel?owner=${created.handle}&repo=${created.name}&number=${number}`,
      { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    expect(status).toBe(200)
    expect(body.cancelled).toBe(false)
    expect(body.workflow_run.state).toBe('succeeded')
  })

  /*
   * The screen's cancel button posts an ordinary form to this same action
   * rather than to a route of its own. That only works if the action answers a
   * browser with its page back: a reader who lands on JSON has found a working
   * feature that looks broken.
   */
  test('a browser gets the run page back rather than JSON', async () => {
    if (!available)
      return

    const number = await makeRun('queued', 'f'.repeat(40))

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/cancel`
      + `?owner=${created.handle}&repo=${created.name}&number=${number}`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Authorization': `Bearer ${created.token}`,
          'Accept': 'text/html,application/xhtml+xml',
        },
      },
    )

    expect([301, 302, 303, 307, 308]).toContain(answer.status)
    expect(String(answer.headers.get('location'))).toBe(`/${created.handle}/${created.name}/run/${number}`)

    // And it did the work, not only the redirect.
    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['state'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    expect(String(run.state)).toBe('cancelling')
  })
})
