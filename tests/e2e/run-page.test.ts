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


describe('following a run that is still going', () => {
  /*
   * The live layer is markup plus a client script, and an e2e that fetches HTML
   * cannot run the script - so what is asserted here is the half that decides
   * whether the script ever gets a chance: the component rendered, it was given
   * the run and the cursor, and a finished run got none of it.
   *
   * That is also the half that fails silently. stx renders a page with every
   * binding undefined when a server script throws, so a missing live region
   * looks exactly like a deliberate decision not to show one.
   */
  test('the page carries the live region, with the cursor its output ends at', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.running}`)

    expect(html).toContain('runlive')
    expect(html).toContain('jobtail')

    /*
     * The setup expression, in the markup.
     *
     * A component's props are consumed when it renders, so the invocation's
     * attributes are gone by the time this sees the page - what has to survive
     * is the `x-init` the scope hydrates from, which stx preserves as
     * `data-stx-xinit`. It did not until 0.2.177: the attribute was dropped on
     * the assumption that the bridge script carried it, which is true for a
     * page and false for an island. Every live region in this codebase rendered
     * its empty state and started nothing, which looks exactly like a live
     * region with nothing to say.
     */
    expect(html).toContain('data-stx-xinit')
    expect(html).toContain('followJob(')
    // Where this page's copy of the output ends. Without it a follower either
    // re-sends the whole log or guesses, and a guess shows a line twice.
    expect(html).toContain('$props.after')
  })

  test('and a finished run is left alone', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    // Nothing to follow. A finished run cannot change, and a page that polls
    // for one is a tab that costs something forever.
    expect(html).not.toContain('runlive')
    expect(html).not.toContain('jobtail')
  })
})


describe('what the run produced', () => {
  /*
   * The collection point. An artifact a run built is no use behind an API call
   * nobody knows to make, and the run screen is where somebody who wants it is
   * already standing.
   */
  test('is listed on the run, with a size and the date it stops being available', async () => {
    if (!available)
      return

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', created.finished)
      .executeTakeFirst()

    await db.insertInto('workflow_artifacts').values({
      workflow_run_id: Number(run.id),
      name: 'coverage.lcov',
      digest: 'b'.repeat(64),
      size_bytes: 5 * 1024 * 1024,
      content_type: 'text/plain',
      expires_at: '2026-12-01T00:00:00.000Z',
    }).execute()

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    expect(html).toContain('coverage.lcov')
    expect(html).toContain('5.0 MB')
    // A date rather than "in 89 days": somebody deciding whether to download it
    // now is comparing against a calendar.
    expect(html).toContain('2026-12-01')
    // The link is the public endpoint, not a second download path only the page
    // knows about.
    expect(html).toContain('/api/repos/workflow-runs/artifact?owner=')
  })
})


describe('a log the runner sent as events', () => {
  /*
   * The four things text cannot carry: which lines were grouped, when each was
   * printed, which stream it came from, and where colour started. This asserts
   * they survive storage and reach the page - and that a job's output still
   * cannot write markup into it, which is the one dangerous thing about
   * rendering a log as anything but `pre`.
   */
  const ESC = String.fromCharCode(27)

  test('renders groups as folds, colour as classes, and markup as text', async () => {
    if (!available)
      return

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', created.running)
      .executeTakeFirst()

    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['id'])
      .where('workflow_run_id', '=', Number(run.id))
      .executeTakeFirst()

    const events = [
      { type: 'group', text: 'Install dependencies', at: '2026-08-13T10:00:00.000Z', stream: 'stdout' },
      { type: 'line', text: `${ESC}[32mbun install succeeded${ESC}[0m`, at: '2026-08-13T10:00:01.000Z', stream: 'stdout' },
      { type: 'line', text: '<script>alert(1)</script>', at: '2026-08-13T10:00:02.000Z', stream: 'stderr' },
      { type: 'endgroup', text: '', at: '', stream: 'stdout' },
      { type: 'line', text: 'see https://example.com/report', at: '2026-08-13T10:00:03.000Z', stream: 'stdout' },
    ]

    await db.insertInto('workflow_job_logs').values({
      workflow_job_id: Number(job.id),
      sequence: 2,
      content: 'Install dependencies\nbun install succeeded\n<script>alert(1)</script>\nsee https://example.com/report\n',
      stream: 'stdout',
      events: JSON.stringify(events),
    }).execute()

    const html = await page(`/${created.handle}/${created.name}/run/${created.running}`)

    // Grouped, and foldable with no script: the run screen carries almost none.
    expect(html).toContain('<details class="log-group"')
    expect(html).toContain('Install dependencies')

    // The colour a test runner meant, as a class rather than an inline style.
    expect(html).toContain('ansi-green')
    expect(html).not.toContain(`${ESC}[32m`)

    // Which stream, without a prefix somebody's build could have printed.
    expect(html).toContain('log-stderr')

    // A link, and one this instance does not vouch for.
    expect(html).toContain('rel="noreferrer nofollow noopener"')

    // And the line that tried to write markup is text.
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
