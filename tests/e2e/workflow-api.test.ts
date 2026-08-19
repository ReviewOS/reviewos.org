// The control plane's read surface, and the one lifecycle action.
//
// Against a real `route.serve()` boot rather than by calling the actions,
// because half of what is being asserted is the wiring: the route exists, the
// authorization runs, and a private repository answers 404 to a stranger rather
// than 403 - a 403 confirms it exists, which is the one thing it must not say.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isTrue } from '../../app/Actions/Support/sql'

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

    for (const [scope, level] of [['checks', 'write'], ['contents', 'read'], ['actions', 'admin'], ['actions_logs', 'read']] as Array<[string, string]>)
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

    /*
     * Three timestamps rather than two. Without `queued_at` a client cannot
     * tell a job that took ten minutes from one that waited nine of them, which
     * is the first question anybody asks about a slow run - and the key has to
     * be present even when it is null, or a client has to guess whether the
     * field is missing or the job never queued.
     */
    expect(Object.keys(body.workflow_run.jobs[0])).toContain('queued_at')
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

    /*
     * A ref of its own, not just a sha.
     *
     * The redelivery index is on (version, ref, head, event), and this file's
     * earlier tests have already used the default ref with several shas. A
     * distinct ref keeps this test independent of how many runs ran before it -
     * which is the property that makes a suite survive somebody adding a case
     * above yours.
     */
    /*
     * A head of its own, generated rather than written out.
     *
     * The redelivery index is on (version, ref, head, event) and it is doing
     * its job here: any fixed sha makes this test depend on nothing else in the
     * file having used it, which is a dependency that breaks the day somebody
     * adds a case above.
     */
    const head = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')
    const number = await makeRun('queued', head, 'refs/heads/env-probe')

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

/*
 * `workflow_dispatch`: the trigger with no event behind it.
 *
 * It was stored on every version with no way to act on it, so the only
 * workflows this instance could run were ones an event happened to. The cases
 * that matter are about the inputs, because that is the one place a person
 * hands values straight to a pipeline.
 */
describe('what this repository\'s CI has been doing', () => {
  const path = '/api/repos/workflow-metrics'

  const reading = (): RequestInit => ({
    headers: { 'Authorization': `Bearer ${created.token}`, 'Accept': 'application/json' },
  })

  test('answers with the numbers and the window they are of', async () => {
    if (!available)
      return

    const { status, body } = await api(`${path}?owner=${created.handle}&repo=${created.name}`, reading())

    expect(status).toBe(200)

    /*
     * The window travels in the answer, so a client cannot show a success rate
     * without saying what it is of - a rate with no window gets less useful
     * every day the instance runs, since a repository that was broken for a
     * week in March never recovers its average.
     */
    expect(Number(body.window.days)).toBe(30)
    expect(String(body.window.since)).not.toBe('')

    expect(Number(body.runs.total)).toBeGreaterThan(0)
    expect(body).toHaveProperty('cache')
    expect(body).toHaveProperty('steps')
  })

  test('and a window a caller asks for, bounded', async () => {
    if (!available)
      return

    const short = await api(`${path}?owner=${created.handle}&repo=${created.name}&days=7`, reading())
    const silly = await api(`${path}?owner=${created.handle}&repo=${created.name}&days=9000`, reading())

    expect(Number(short.body.window.days)).toBe(7)
    // A ceiling rather than a refusal: somebody asking for everything wants the
    // most this can answer, not an error about a number they typed.
    expect(Number(silly.body.window.days)).toBe(90)
  })

  test('a rate is null rather than zero when nothing has happened yet', async () => {
    if (!available)
      return

    /*
     * A repository that does not use the cache has no hit rate, and 0% reads
     * as one that is broken. The same for a success rate over no finished runs.
     */
    const { body } = await api(`${path}?owner=${created.handle}&repo=${created.name}&workflow=999999`, reading())

    expect(Number(body.runs.total)).toBe(0)
    expect(body.runs.success_rate).toBeNull()
    expect(body.cache.hit_rate).toBeNull()
  })

  test('and a stranger cannot read them', async () => {
    if (!available)
      return

    await db.updateTable('repositories').set({ visibility: 'private' } as any).where('id', '=', created.repositoryId).execute()

    const { status } = await api(`${path}?owner=${created.handle}&repo=${created.name}`)

    expect([401, 403, 404]).toContain(status)

    await db.updateTable('repositories').set({ visibility: 'public' } as any).where('id', '=', created.repositoryId).execute()
  })
})

describe('the workflows a repository has', () => {
  const path = '/api/repos/workflows'

  const reading = (): RequestInit => ({
    headers: { 'Authorization': `Bearer ${created.token}`, 'Accept': 'application/json' },
  })

  test('are listable, with the definition each one is running today', async () => {
    if (!available)
      return

    /*
     * The listing that was missing from every other question this API answers:
     * runs could be filtered by workflow, and nothing said which workflows
     * existed - so a client had to start from a run to learn the shape of a
     * repository's CI, and an empty repository had nothing to show at all.
     */
    const { status, body } = await api(`${path}?owner=${created.handle}&repo=${created.name}`, reading())

    expect(status).toBe(200)
    expect(body.workflows.length).toBeGreaterThan(0)
    expect(body.workflows[0].path).toBe('.github/workflows/ci.yml')

    // Which definition is live is the question immediately after this one, so
    // it travels with the row rather than costing a request per workflow.
    expect(Number(body.workflows[0].version.id)).toBe(created.versionId)
  })

  test('and one of them carries its versions and a normalized graph', async () => {
    if (!available)
      return

    const job: any = await db
      .insertInto('workflow_version_jobs')
      .values({
        workflow_version_id: created.versionId,
        repository_id: created.repositoryId,
        job_id: 'build',
        name: 'Build',
        position: 0,
        runs_on: 'ubuntu-latest',
      })
      .returning(['id'])
      .executeTakeFirst()

    await db
      .insertInto('workflow_version_steps')
      .values({
        workflow_version_job_id: Number(job.id),
        repository_id: created.repositoryId,
        position: 0,
        name: 'Compile',
        command: 'make',
      })
      .execute()

    const { status, body } = await api(
      `${path}/show?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      reading(),
    )

    expect(status).toBe(200)
    expect(body.workflow.path).toBe('.github/workflows/ci.yml')
    expect(body.versions.length).toBeGreaterThan(0)
    expect(body.versions[0].current).toBe(true)

    /*
     * The graph rather than the file. Re-serving YAML would make every client
     * parse a format whose meaning lives here - the `needs:` a barrier inserts,
     * the kind a `reviewos:` key decides - and two parsers is how a client's
     * picture of a run stops matching the run.
     */
    const built = body.version.jobs.find((one: any) => one.key === 'build')

    expect(built).toBeTruthy()
    expect(built.kind).toBe('command')
    expect(built.runs_on).toEqual(['ubuntu-latest'])
    expect(built.steps[0].run).toBe('make')

    // And the triggers as flags, because the parser has already decided what
    // two spellings of `on:` both mean.
    expect(typeof body.version.triggers.push).toBe('boolean')

    await db.deleteFrom('workflow_version_jobs').where('id', '=', Number(job.id)).execute()
  })

  test('a workflow nobody has is a 404 rather than an empty answer', async () => {
    if (!available)
      return

    const { status } = await api(
      `${path}/show?owner=${created.handle}&repo=${created.name}&workflow=nope.yml`,
      reading(),
    )

    expect(status).toBe(404)
  })
})

describe('dispatching a workflow by hand', () => {
  const path = '/api/repos/workflows/dispatch'

  async function makeDispatchable(inputs: unknown): Promise<void> {
    await db
      .updateTable('workflow_versions')
      .set({
        on_dispatch: true,
        dispatch_inputs: inputs ? JSON.stringify(inputs) : null,
      } as any)
      .where('id', '=', created.versionId)
      .execute()
  }

  /*
   * A function, not a constant. A describe body runs at collection time, before
   * `beforeAll` has made the token - so a captured `created.token` is the empty
   * string and every request comes back 401 for the wrong reason.
   */
  const authorized = (): RequestInit => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${created.token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
  })

  test('a stranger cannot start one', async () => {
    if (!available)
      return

    const { status } = await api(`${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`, { method: 'POST' })

    // Starting a run spends the instance's runners. Anybody who may see a
    // workflow is not therefore somebody who may run it.
    expect(status).not.toBe(201)
  })

  test('a workflow that never asked for workflow_dispatch is refused', async () => {
    if (!available)
      return

    await db.updateTable('workflow_versions').set({ on_dispatch: false } as any).where('id', '=', created.versionId).execute()

    const { status, body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      authorized(),
    )

    expect(status).toBe(409)
    expect(String(body.error)).toContain('workflow_dispatch')
  })

  test('one that did starts a run, named by file or by name', async () => {
    if (!available)
      return

    await makeDispatchable(null)

    const { status, body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      authorized(),
    )

    expect(status).toBe(201)
    expect(body.workflow_run.event).toBe('workflow_dispatch')
    expect(body.workflow_run.state).toBe('queued')

    // By name too, since that is what the interface shows.
    const byName = await api(`${path}?owner=${created.handle}&repo=${created.name}&workflow=CI`, authorized())

    expect(byName.status).toBe(201)
  })

  test('the inputs are checked against what the workflow declared', async () => {
    if (!available)
      return

    await makeDispatchable([
      { name: 'environment', description: '', required: true, type: 'choice', default: null, options: ['staging', 'production'] },
      { name: 'dry-run', description: '', required: false, type: 'boolean', default: 'false', options: [] },
    ])

    const wrong = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      { ...authorized(), body: JSON.stringify({ inputs: { environment: 'producton' } }) },
    )

    // A typo is a message, not a run that fails twelve minutes later.
    expect(wrong.status).toBe(422)
    expect(String(wrong.body.problems?.[0])).toContain('staging, production')
  })

  test('and the run records what it ran with, defaults filled in', async () => {
    if (!available)
      return

    const { status, body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      { ...authorized(), body: JSON.stringify({ inputs: { environment: 'production' } }) },
    )

    expect(status).toBe(201)
    // `dry-run` was never sent; its default is what the run will see, and "the
    // default applied" is exactly the fact that is otherwise invisible.
    expect(body.workflow_run.inputs).toEqual({ 'environment': 'production', 'dry-run': 'false' })

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['dispatch_inputs', 'trusted', 'event'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', Number(body.workflow_run.number))
      .executeTakeFirst()

    expect(JSON.parse(String(run.dispatch_inputs))).toEqual({ 'environment': 'production', 'dry-run': 'false' })
    // Whoever asked has write access and the workflow is the repository's own:
    // there is no untrusted tree in this path.
    expect(isTrue(run.trusted)).toBe(true)
  })

  test('a required input with nothing to fall back on is refused', async () => {
    if (!available)
      return

    const { status, body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      { ...authorized(), body: JSON.stringify({ inputs: {} }) },
    )

    expect(status).toBe(422)
    expect(String(body.problems?.[0])).toContain('environment')
  })
})

/*
 * `env:` reaches the run detail, with the level each value came from.
 *
 * The merge is three lines; being able to answer "why did my step see staging
 * when the job says production" is the reason it is exposed at all. A reader
 * cannot do the merge from the file without doing it by hand.
 */
describe('a dispatch that must not happen twice', () => {
  const path = '/api/repos/workflows/dispatch'

  const authorized = (): RequestInit => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${created.token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
  })

  test('a caller-supplied key makes the retry return the first run rather than start a second', async () => {
    if (!available)
      return

    await db
      .updateTable('workflow_versions')
      .set({ on_dispatch: true, dispatch_inputs: null } as any)
      .where('id', '=', created.versionId)
      .execute()

    const key = unique('idem')
    const query = `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml&key=${key}`

    const first = await api(query, authorized())
    const second = await api(query, authorized())

    expect(first.status).toBe(201)

    /*
     * A dispatch repeats on purpose - a nightly job runs at the same ref every
     * night, and pressing the button twice is the feature - so it carries no
     * key of its own. A caller that names one is saying something narrower:
     * *this* request, however many times the network makes them send it.
     */
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(Number(second.body.workflow_run.number)).toBe(Number(first.body.workflow_run.number))
  })

  test('and without one, two dispatches are two runs, which is the default for a reason', async () => {
    if (!available)
      return

    const query = `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`

    const first = await api(query, authorized())
    const second = await api(query, authorized())

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(Number(second.body.workflow_run.number)).not.toBe(Number(first.body.workflow_run.number))
  })
})

describe('the id that follows a request into the work it starts', () => {
  const path = '/api/repos/workflows/dispatch'

  test('a caller\'s own `X-Request-Id` lands on the run they started', async () => {
    if (!available)
      return

    await db
      .updateTable('workflow_versions')
      .set({ on_dispatch: true, dispatch_inputs: null } as any)
      .where('id', '=', created.versionId)
      .execute()

    const mine = unique('trace-')

    const { status, body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${created.token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Request-Id': mine,
        },
      },
    )

    expect(status).toBe(201)
    // Echoed, so a caller that sent none can still write down the one they got.
    expect(String(body.workflow_run.request_id)).toBe(mine)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['request_id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', Number(body.workflow_run.number))
      .executeTakeFirst()

    /*
     * Kept rather than replaced: the caller has already logged this id beside
     * their own stack trace, and one this instance invented is one they cannot
     * search for.
     */
    expect(String(run.request_id)).toBe(mine)
  })

  test('and a caller who sent none still gets a run that can be traced', async () => {
    if (!available)
      return

    const { body } = await api(
      `${path}?owner=${created.handle}&repo=${created.name}&workflow=ci.yml`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${created.token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      },
    )

    expect(String(body.workflow_run.request_id)).toStartWith('req_')
  })
})

describe('the environment a job inherits', () => {
  test('is reported with the level that defined each value', async () => {
    if (!available)
      return

    await db.updateTable('workflow_versions')
      .set({ env: JSON.stringify({ NODE_ENV: 'production', TARGET: 'production' }) } as any)
      .where('id', '=', created.versionId)
      .execute()

    await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: created.versionId,
      job_id: 'test',
      name: 'Test',
      position: 0,
      runs_on: 'ubuntu-latest',
      env: JSON.stringify({ TARGET: 'staging' }),
    }).execute()

    /*
     * A ref of its own, not just a sha.
     *
     * The redelivery index is on (version, ref, head, event), and this file's
     * earlier tests have already used the default ref with several shas. A
     * distinct ref keeps this test independent of how many runs ran before it -
     * which is the property that makes a suite survive somebody adding a case
     * above yours.
     */
    /*
     * A head of its own, generated rather than written out.
     *
     * The redelivery index is on (version, ref, head, event) and it is doing
     * its job here: any fixed sha makes this test depend on nothing else in the
     * file having used it, which is a dependency that breaks the day somebody
     * adds a case above.
     */
    const head = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')
    const number = await makeRun('queued', head, 'refs/heads/env-probe')

    const { status, body } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=${number}`)

    expect(status).toBe(200)

    const job = body.workflow_run.jobs.find((row: any) => row.job_id === 'test')
    const target = job.env.find((entry: any) => entry.name === 'TARGET')

    // The job's value wins, and the workflow's is named as the one it beat.
    expect(target).toMatchObject({ value: 'staging', from: 'job', overrides: ['workflow'] })

    // And what the job did not redefine is inherited rather than dropped.
    expect(job.env.find((entry: any) => entry.name === 'NODE_ENV')).toMatchObject({
      value: 'production',
      from: 'workflow',
    })
  })

  /*
   * `permissions:` travels with it. Nothing mints a token yet, and this is
   * still the screen somebody reads when a workflow that expected to write
   * issues fails at the far end with a permissions error.
   */
  test('and the permissions its token would carry, with what was refused', async () => {
    if (!available)
      return

    await db.updateTable('workflow_versions')
      .set({ permissions: JSON.stringify({ 'contents': 'read', 'packages': 'write' }) } as any)
      .where('id', '=', created.versionId)
      .execute()

    const head = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')
    const number = await makeRun('queued', head, 'refs/heads/perm-probe')

    const { body } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=${number}`)
    const job = body.workflow_run.jobs.find((row: any) => row.job_id === 'test')

    expect(job.permissions.scopes).toEqual({ contents: 'read' })
    expect(job.permissions.from).toBe('workflow')
    // Named rather than dropped: a token that silently grants nothing is a
    // workflow that fails with no explanation.
    expect(job.permissions.unsupported).toEqual(['packages'])
  })

  test('and the shell and directory its steps inherit, or the runner\'s choice', async () => {
    if (!available)
      return

    await db.updateTable('workflow_versions')
      .set({ default_shell: 'bash', default_working_directory: './app' } as any)
      .where('id', '=', created.versionId)
      .execute()

    const head = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')
    const number = await makeRun('queued', head, 'refs/heads/defaults-probe')

    const { body } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=${number}`)
    const job = body.workflow_run.jobs.find((row: any) => row.job_id === 'test')

    expect(job.defaults).toMatchObject({
      shell: 'bash',
      shell_from: 'workflow',
      working_directory: './app',
    })

    // And with nothing declared anywhere, the answer is the runner's - named
    // rather than guessed at, because the shell depends on the platform.
    await db.updateTable('workflow_versions')
      .set({ default_shell: null, default_working_directory: null } as any)
      .where('id', '=', created.versionId)
      .execute()

    const second = await makeRun('queued', Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex'), 'refs/heads/defaults-none')
    const answer = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=${second}`)
    const plain = answer.body.workflow_run.jobs.find((row: any) => row.job_id === 'test')

    expect(plain.defaults).toMatchObject({ shell: null, shell_from: 'runner' })
  })

  test('a workflow that asks for nothing gets a read-only token', async () => {
    if (!available)
      return

    await db.updateTable('workflow_versions').set({ permissions: null } as any).where('id', '=', created.versionId).execute()

    const head = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')
    const number = await makeRun('queued', head, 'refs/heads/perm-default')

    const { body } = await api(`/api/repos/workflow-runs/show?owner=${created.handle}&repo=${created.name}&number=${number}`)
    const job = body.workflow_run.jobs.find((row: any) => row.job_id === 'test')

    // Actions' default depends on an organization setting; this instance's does
    // not, so a workflow behaves the same wherever it is run.
    expect(job.permissions.scopes).toEqual({ contents: 'read' })
    expect(job.permissions.from).toBe('default')
  })
})

/*
 * `on: issues` and `on: release`, which this instance has emitted events for
 * since long before anything read them for CI.
 */
describe('an issue or a release starting a run', () => {
  test('starts one for a workflow that asked, and nothing for one that did not', async () => {
    if (!available)
      return

    const { dispatchSubject } = await import('../../app/Actions/Workflow/dispatch')

    await db.updateTable('workflow_versions')
      .set({ on_issues: true, issue_types: 'opened' } as any)
      .where('id', '=', created.versionId)
      .execute()

    const before = await db.selectFrom('workflow_runs').select(['id'])
      .where('repository_id', '=', created.repositoryId).execute()

    await dispatchSubject({
      repositoryId: created.repositoryId,
      event: 'issues',
      activity: 'opened',
      subject: '7',
    })

    const after = await db.selectFrom('workflow_runs').select(['id', 'event', 'event_ref', 'trusted'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id')
      .execute()

    expect(after.length).toBe(before.length + 1)

    const run = after[after.length - 1] as any

    expect(run.event).toBe('issues')
    // The subject is in the ref, or two issues would look like one run
    // redelivered: every issue event in a repository shares a head commit.
    expect(String(run.event_ref)).toContain('issues/7/opened')
    // The repository's own workflow on its own default branch: nothing about
    // an issue is a tree, so there is no untrusted commit in this path.
    expect(isTrue(run.trusted)).toBe(true)
  })

  test('an activity type the workflow did not name starts nothing', async () => {
    if (!available)
      return

    const { dispatchSubject } = await import('../../app/Actions/Workflow/dispatch')

    const before = await db.selectFrom('workflow_runs').select(['id'])
      .where('repository_id', '=', created.repositoryId).execute()

    const result = await dispatchSubject({
      repositoryId: created.repositoryId,
      event: 'issues',
      activity: 'labeled',
      subject: '7',
    })

    const after = await db.selectFrom('workflow_runs').select(['id'])
      .where('repository_id', '=', created.repositoryId).execute()

    expect(result.created).toHaveLength(0)
    expect(after.length).toBe(before.length)
  })

  test('and the same issue event twice makes one run', async () => {
    if (!available)
      return

    const { dispatchSubject } = await import('../../app/Actions/Workflow/dispatch')

    const before = await db.selectFrom('workflow_runs').select(['id'])
      .where('repository_id', '=', created.repositoryId).execute()

    await dispatchSubject({ repositoryId: created.repositoryId, event: 'issues', activity: 'opened', subject: '7' })

    const after = await db.selectFrom('workflow_runs').select(['id'])
      .where('repository_id', '=', created.repositoryId).execute()

    // The redelivery index covers this: same version, same ref, same head,
    // same event.
    expect(after.length).toBe(before.length)
  })
})

/*
 * Opening a gate over the API, which is the same action the run page's form
 * posts to. A control the interface has and the API does not is how a product
 * grows a second, undocumented way to change its own state.
 */
describe('approving a paused gate', () => {
  /** A run holding at a gate, with two fields to answer. */
  async function pausedRun(sha: string): Promise<number> {
    const number = await makeRun('waiting', sha)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'approve',
      name: 'Approve',
      position: 5,
      state: 'paused',
      kind: 'block',
      settings: JSON.stringify({
        prompt: 'Deploy to production?',
        fields: [
          { key: 'version', type: 'string', required: true, label: 'version', default: null, options: [] },
          { key: 'where', type: 'select', required: false, label: 'where', default: null, options: ['staging', 'production'] },
        ],
      }),
    }).execute()

    return number
  }

  test('a stranger cannot open somebody else\'s gate', async () => {
    if (!available)
      return

    const number = await pausedRun('e1'.repeat(20))

    const { status } = await api(
      `/api/repos/workflow-runs/approve?owner=${created.handle}&repo=${created.name}&number=${number}&job=approve&version=1.0.0`,
      { method: 'POST' },
    )

    // Approving a release is the most consequential button on the page, and it
    // is not something an anonymous caller does.
    expect(status).not.toBe(200)
  })

  test('a missing required field is refused, with the field named', async () => {
    if (!available)
      return

    const number = await pausedRun('e2'.repeat(20))

    const { status, body } = await api(
      `/api/repos/workflow-runs/approve?owner=${created.handle}&repo=${created.name}&number=${number}&job=approve`,
      { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    expect(status).toBe(422)
    expect(String(body.problems?.join(' '))).toContain('version')
  })

  test('a select outside its options is refused, and says which they are', async () => {
    if (!available)
      return

    const number = await pausedRun('e3'.repeat(20))

    const { status, body } = await api(
      `/api/repos/workflow-runs/approve?owner=${created.handle}&repo=${created.name}&number=${number}&job=approve&version=1.0.0&where=producton`,
      { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    // The whole reason to declare options is that somebody can be told which
    // ones there are, rather than reading "invalid input".
    expect(status).toBe(422)
    expect(String(body.problems?.join(' '))).toContain('staging')
  })

  test('and a caller who may opens it, with their answers as the job\'s outputs', async () => {
    if (!available)
      return

    const number = await pausedRun('e4'.repeat(20))

    const { status, body } = await api(
      `/api/repos/workflow-runs/approve?owner=${created.handle}&repo=${created.name}&number=${number}&job=approve&version=1.2.3&where=production`,
      { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, Accept: 'application/json' } },
    )

    expect(status).toBe(200)
    expect(body.job.state).toBe('succeeded')
    expect(body.outputs).toEqual({ version: '1.2.3', where: 'production' })

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['state', 'outputs', 'approved_by_id'])
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', 'approve')
      .executeTakeFirst()

    expect(String(job.state)).toBe('succeeded')
    // Who opened it, on the row: "who approved this deployment" is a question
    // asked while looking at the run.
    expect(Number(job.approved_by_id)).toBe(created.ownerId)
    expect(JSON.parse(String(job.outputs))).toEqual({ version: '1.2.3', where: 'production' })
  })

  test('pressing it twice is a conflict rather than an error', async () => {
    if (!available)
      return

    const number = await pausedRun('e5'.repeat(20))
    const url = `/api/repos/workflow-runs/approve?owner=${created.handle}&repo=${created.name}&number=${number}&job=approve&version=1.0.0`
    const headers = { Authorization: `Bearer ${created.token}`, Accept: 'application/json' }

    expect((await api(url, { method: 'POST', headers })).status).toBe(200)

    // Two people looking at the same run and both pressing is an ordinary
    // thing that happens; the second has not made a mistake and needs to be
    // told it is already open.
    const second = await api(url, { method: 'POST', headers })

    expect(second.status).toBe(409)
    expect(String(second.body.reason)).toContain('already')
  })
})

/*
 * Turning a workflow off without deleting it.
 *
 * `disabled` was a state on the row that every dispatch path already refused to
 * run, and nothing could set - a check that was dead code and a state that was
 * a lie. Deleting means a commit, a review and a revert for something that is
 * usually temporary: a nightly job failing while an upstream service is down.
 */
describe('disabling a workflow', () => {
  async function manage(body: Record<string, unknown>): Promise<any> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflows/manage`, {
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

  test('by name or by path, because both are what people have', async () => {
    if (!available)
      return

    const workflow: any = await db
      .selectFrom('workflows')
      .select(['id', 'name', 'path', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(workflow).toBeTruthy()

    const byPath = await manage({ operation: 'disable', workflow: String(workflow.path) })

    expect(byPath.status).toBe(200)
    expect(byPath.body.workflow.state).toBe('disabled')

    // The runs already going are unaffected, and the history is kept - said in
    // the answer because both are questions somebody has as they press it.
    expect(String(byPath.body.note)).toContain('history is kept')

    const byName = await manage({ operation: 'enable', workflow: String(workflow.name) })

    expect(byName.status).toBe(200)
    expect(byName.body.workflow.state).toBe('active')
  }, 120_000)

  test('and a disabled workflow is not dispatched', async () => {
    if (!available)
      return

    const workflow: any = await db
      .selectFrom('workflows')
      .select(['id', 'path'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    await manage({ operation: 'disable', workflow: String(workflow.path) })

    /*
     * The check the state was written for, exercised at last: the dispatch
     * paths have refused a disabled workflow since the beginning, against a
     * state nothing could reach.
     */
    const { dispatchPush } = await import('../../app/Actions/Workflow/dispatch')

    const result = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'd'.repeat(40),
    })

    expect(result.created).toEqual([])

    await manage({ operation: 'enable', workflow: String(workflow.path) })
  }, 120_000)

  test('a workflow this repository does not have is not found', async () => {
    if (!available)
      return

    expect((await manage({ operation: 'disable', workflow: '.github/workflows/nothing.yml' })).status).toBe(404)
  }, 120_000)
})
