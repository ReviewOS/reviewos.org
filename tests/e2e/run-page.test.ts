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

/** The commit a run is about, for a test that has to file a check against it. */
async function headShaOfRun(number: number): Promise<string> {
  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['head_sha'])
    .where('repository_id', '=', created.repositoryId)
    .where('number', '=', number)
    .executeTakeFirst()

  return String(run?.head_sha ?? '')
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
    /*
     * A step has no `queued` state, and that is deliberate rather than an
     * omission: a step waiting for its job is not waiting in a queue, it simply
     * has not begun. `pending` is what the model calls that.
     */
    state: jobState === 'queued' ? 'pending' : jobState,
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

/*
 * A step summary is the one part of a run written *for a reader* - the table of
 * what was built, the three numbers somebody wanted - and it was being kept on
 * the check and shown nowhere. A run page with ten thousand lines of output and
 * not the paragraph the job wrote has the two the wrong way round.
 */
describe('what a job wrote about itself', () => {
  test('the step summary renders as markdown on the run', async () => {
    if (!available)
      return

    const sha = await headShaOfRun(created.finished)

    await db.insertInto('check_runs').values({
      repository_id: created.repositoryId,
      head_sha: sha,
      // Filed under the job's name, which is how the annotation endpoint files
      // it and how this page finds it.
      name: 'Build the thing',
      status: 'completed',
      conclusion: 'success',
      provider: 'workflow',
      summary: '### Built it\n\n| package | size |\n| --- | --- |\n| app | 1.2 MB |\n',
    } as any).execute()

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    expect(html).toContain('Built it')
    // Markdown, not the literal pipes and dashes somebody would otherwise be
    // reading off the screen.
    expect(html).toContain('<table')
    expect(html).toContain('1.2 MB')
    expect(html).not.toContain('| --- |')
  })

  test('and a summary cannot take the page\'s own heading ids', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    // Headings come from a step's markdown, which is to say from anybody who
    // can push. An id is a global name on the page, so user-chosen ones live
    // in their own namespace.
    expect(html).toContain('id="summary-')
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

/*
 * The most expensive screen in a forge is a run that sits at "queued" with a
 * spinner: it looks like the instance is thinking, so people wait, then wait
 * longer, then ask in a chat channel. The instance knew the answer the whole
 * time.
 */
describe('a run that is waiting for a runner', () => {
  test('says why, and which labels would have matched', async () => {
    if (!available)
      return

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    /*
     * The job is queued; its step is `pending`, which is the state a step has
     * before anything has run it. `queued` is a *job* state and not a step one -
     * the two enums are deliberately different, because a step waiting for its
     * job is not waiting in a queue.
     */
    const number = await makeRun(Number(version.id), 'queued', 'queued', '', 'e'.repeat(40))

    // A job asking for something no runner here has.
    await db
      .updateTable('workflow_jobs')
      .set({ runs_on: 'macos-14' } as any)
      .where('workflow_run_id', '=', (await db
        .selectFrom('workflow_runs')
        .select(['id'])
        .where('repository_id', '=', created.repositoryId)
        .where('number', '=', number)
        .executeTakeFirst() as any).id)
      .execute()

    const runner: any = await db.insertInto('runners').values({
      name: `page-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`,
      scope_type: 'instance',
      scope_id: null,
      token_hash: 'x'.repeat(64),
      labels: 'ubuntu-latest\nself-hosted',
      state: 'active',
      version: '1',
    }).returning(['id']).executeTakeFirst()

    try {
      const html = await page(`/${created.handle}/${created.name}/run/${number}`, created.ownerToken)

      // Both halves: what it asked for, and what it could have asked for.
      expect(html).toContain('macos-14')
      expect(html).toContain('ubuntu-latest')
      expect(html).toContain('No runner here has')

      // And what to do about it, because the reader here can act on it: this
      // page is fetched with the owner's token.
      expect(html).toContain('runs-on')
    }
    finally {
      await db.deleteFrom('runners').where('id', '=', Number(runner.id)).execute().catch(() => {})
    }
  }, 60_000)
})

/*
 * The empty state of the workflows page, which is where somebody decides
 * whether CI here is worth the afternoon. "No workflows are registered" is true
 * and useless; a file they can copy that actually runs is the difference
 * between trying it and closing the tab.
 */
describe('how long a job waited, against how long it ran', () => {
  test('are two numbers on the page, not one', async () => {
    if (!available)
      return

    /*
     * A slow run is usually a queue problem, and one combined figure cannot
     * say which: "eleven minutes" reads the same whether the job took eleven
     * minutes or spent nine of them waiting for a machine that was not there.
     */
    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', created.finished)
      .executeTakeFirst()

    const started = new Date(Date.now() - 600_000)

    await db
      .updateTable('workflow_jobs')
      .set({
        queued_at: new Date(started.getTime() - 540_000).toISOString(),
        started_at: started.toISOString(),
        finished_at: new Date(started.getTime() + 60_000).toISOString(),
      } as any)
      .where('workflow_run_id', '=', Number(run.id))
      .execute()

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    // Nine minutes waiting, one minute working - and the page says so in those
    // words rather than leaving a reader to subtract two timestamps.
    expect(html).toContain('waited 9m 0s')
    expect(html).toContain('ran 1m 0s')
  })
})

describe('the shape of a run', () => {
  test('shows the dependency layers and the chain that decided its length', async () => {
    if (!available)
      return

    /*
     * A list of jobs cannot say which ones could have run at the same time, nor
     * which chain the run's length actually came from - and adding runners does
     * nothing for a run that is one chain of dependent jobs.
     */
    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', created.finished)
      .executeTakeFirst()

    const started = new Date(Date.now() - 900_000)

    // A second job, behind the first, so there is a graph to draw at all.
    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'deploy',
      name: 'Deploy it',
      position: 1,
      state: 'succeeded',
      needs: 'build',
      runs_on: 'ubuntu-latest',
      queued_at: new Date(started.getTime() + 120_000).toISOString(),
      started_at: new Date(started.getTime() + 180_000).toISOString(),
      finished_at: new Date(started.getTime() + 600_000).toISOString(),
    } as any).execute()

    await db
      .updateTable('workflow_jobs')
      .set({ job_id: 'build' } as any)
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', 'build')
      .execute()

    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    expect(html).toContain('Shape of this run')

    // The chain, named in order, with the split between working and waiting -
    // which is what says whether to add machines or to change the pipeline.
    expect(html).toContain('Longest chain:')
    expect(html).toContain('Deploy it')
    expect(html).toContain('waiting for a machine')
  })
})

describe('where a run came from', () => {
  test('the page says which file, which version, what set it off, and who asked', async () => {
    if (!available)
      return

    /*
     * The six facts somebody needs when they did not start the run. Scattered
     * across four screens they are an investigation; on the run they are a
     * paragraph.
     */
    const html = await page(`/${created.handle}/${created.name}/run/${created.finished}`)

    const shown = html.slice(html.indexOf('run-provenance'), html.indexOf('run-provenance') + 400)

    // The file that ran, the version of it, what set the run off, and on which
    // ref - in one paragraph rather than across four screens.
    expect(shown).toContain('workflows/ci.yml')
    expect(shown).toContain('push')
    expect(shown).toContain('refs/heads/')
  })
})

describe('a repository with no workflows', () => {
  test('is offered starters that are real Actions workflows', async () => {
    if (!available)
      return

    // Its own repository, because this page is about *not* having workflows and
    // the one above has three.
    const handle = created.handle
    const name = unique('empty')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${handle}/${name}.git`,
    }).returning(['id']).executeTakeFirst()

    try {
      const html = await page(`/${handle}/${name}/workflows`, created.ownerToken)

      expect(html).toContain('No workflows are registered')
      expect(html).toContain('Start with one of these')

      // A starter is only worth offering if it runs here *and* would run on
      // GitHub, which is what makes the compatibility claim checkable rather
      // than something to believe.
      expect(html).toContain('npm ci')
      expect(html).toContain('workflow_dispatch')
      expect(html).toContain('cron')
    }
    finally {
      await db.deleteFrom('repositories').where('id', '=', Number(repository.id)).execute().catch(() => {})
    }
  }, 60_000)

  test('and a repository that has one is not', async () => {
    if (!available)
      return

    // The starters are an empty state, not an advertisement: a page that keeps
    // suggesting templates to somebody who already has CI is one they learn to
    // scroll past.
    const html = await page(`/${created.handle}/${created.name}/workflows`, created.ownerToken)

    expect(html).not.toContain('Start with one of these')
  }, 60_000)
})

/*
 * A gate on the screen. The engine's half is tested elsewhere; this is the
 * half that decides whether anybody can actually use it - a run holding for a
 * person, with the prompt, the fields, and a button only somebody who may
 * approve is shown.
 */
describe('a run waiting at a gate', () => {
  let number = 0

  test('shows the prompt and the fields the workflow declared', async () => {
    if (!available)
      return

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    number = await makeRun(Number(version.id), 'waiting', 'succeeded', '', 'ab'.repeat(20))

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'approve',
      name: 'Approve the deploy',
      position: 9,
      state: 'paused',
      kind: 'block',
      group_label: 'Release',
      settings: JSON.stringify({
        prompt: 'Deploy to production?',
        fields: [
          { key: 'where', type: 'select', label: 'where', required: false, default: null, options: ['staging', 'production'] },
        ],
      }),
    }).execute()

    const html = await page(`/${created.handle}/${created.name}/run/${number}`, created.ownerToken)

    expect(html).toContain('Deploy to production?')
    /*
     * The option element specifically, not just the word: it can only come
     * from the field loop, and the first version of this test passed while
     * that loop rendered nothing at all.
     */
    expect(html).toContain('name="where"')
    expect(html).toContain('<option value="production"')
    // The group prints once, as a heading over the jobs that share it.
    expect(html).toContain('Release')
    expect(html).toContain('/api/repos/workflow-runs/approve')
  }, 60_000)

  test('and a reader who may not approve is told who can, not shown a button', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}/run/${number}`)

    // The prompt is still worth showing: everybody deserves to know the run is
    // waiting for a person rather than for a machine.
    expect(html).toContain('Deploy to production?')
    expect(html).not.toContain('/api/repos/workflow-runs/approve')
    expect(html).toContain('write access')
  }, 60_000)
})
