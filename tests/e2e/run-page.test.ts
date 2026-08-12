// The run screen: what it says, and what it offers to whom.
//
// Asked of the rendered page rather than of the helpers behind it, because stx
// fails silently. A server script that throws renders the template with every
// variable undefined, so a broken query here does not produce an error - it
// produces a run page with no jobs, no log, and no cancel button, which reads
// as a run that has not started yet.
//
// The cancel control is the part worth pinning. It posts to the same public
// action the API and the CLI call, and it is shown on `workflow:cancel` - the
// ability the action enforces - so a reader is never offered something that
// would then be refused, and a stranger is never offered it at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  outsiderToken: '',
  repositoryId: 0,
  handle: '',
  name: '',
  running: 0,
  finished: 0,
}

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The page as a reader receives it, optionally signed in. */
async function page(path: string, token?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return await answer.text()
}

/** A run in a given state, with one job, one step, and some output. */
async function makeRun(versionId: number, state: string, jobState: string, log: string, sha: string): Promise<number> {
  const previous: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  const number = Number(previous?.number ?? 0) + 1

  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: versionId,
    repository_id: created.repositoryId,
    number,
    state,
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: sha,
    definition_sha: sha,
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  const job: any = await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    job_id: 'build',
    name: 'Build the thing',
    position: 0,
    state: jobState,
    runs_on: 'ubuntu-latest',
  }).returning(['id']).executeTakeFirst()

  await db.insertInto('workflow_steps').values({
    workflow_job_id: Number(job.id),
    position: 0,
    name: 'Compile',
    state: jobState,
    attempts: 1,
  }).execute()

  await db.insertInto('workflow_job_logs').values({
    workflow_job_id: Number(job.id),
    sequence: 1,
    stream: 'stdout',
    content: log,
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

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db.insertInto('users')
        .values({ name: 'Run Reader', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'run page test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('rpo')
    const outsider = await make('rpx')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.ownerToken = owner.token
    created.outsiderToken = outsider.token
    created.name = unique('rrepo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/ci.yml',
      name: 'CI',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: Number(workflow.id),
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/ci.yml',
      content_digest: unique('digest'),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.running = await makeRun(Number(version.id), 'running', 'running', 'compiling the thing\n', 'c'.repeat(40))
    created.finished = await makeRun(Number(version.id), 'succeeded', 'succeeded', 'all good\n', 'd'.repeat(40))

    available = true
  }
  catch (error) {
    console.warn(`[run-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('the run screen', () => {
  test('renders the run, its jobs, its steps and its output', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.running}`)

    expect(html).toContain('CI')
    expect(html).toContain('Build the thing')
    expect(html).toContain('Compile')
    // The log on the page rather than behind a fetch: the run is usually over
    // by the time anybody opens this.
    expect(html).toContain('compiling the thing')
  })

  test('a run number nobody has is a 404 rather than an empty page', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/run/999999`, {
      headers: { Accept: 'text/html' },
    })

    expect(answer.status).toBe(404)
  })
})

describe('the cancel control', () => {
  test('is offered to somebody who may cancel, and posts to the public action', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.running}`, created.ownerToken)

    expect(html).toContain('Cancel run')
    // Not a route of its own. A control the interface has and the API does not
    // is how a product grows a second, undocumented way to change its state.
    expect(html).toContain('/api/repos/workflow-runs/cancel')
  })

  test('is not offered to a reader who may not', async () => {
    if (!available)
      return

    // A public repository, so both of these can read the run. Reading is not
    // permission to stop it: a cancel button everybody can press is a denial of
    // service with an affordance.
    const stranger = await page(`/${created.handle}/${created.name}/run/${created.running}`)
    const outsider = await page(`/${created.handle}/${created.name}/run/${created.running}`, created.outsiderToken)

    expect(stranger).not.toContain('Cancel run')
    expect(outsider).not.toContain('Cancel run')
  })

  test('and is not offered on a run that has already finished', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`, created.ownerToken)

    expect(html).toContain('all good')
    expect(html).not.toContain('Cancel run')
  })
})
