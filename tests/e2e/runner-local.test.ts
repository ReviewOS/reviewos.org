// The local runner: this host executing this instance's jobs.
//
// The single-tenant execution plane. Everything else in phase 15 decides what
// *should* run; this is the first thing that runs it, so the test is the whole
// path - push a workflow, let the dispatcher make a run, hand it to the runner,
// and read the logs and the conclusion back out of the API.
//
// It runs the real protocol over HTTP rather than reaching into the database,
// because the rules that matter - leases, job tokens, late reports - live in
// the protocol and a runner that skips them is not the runner anybody else has.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const created = {
  ownerId: 0,
  repositoryId: 0,
  runnerId: 0,
  handle: '',
  name: '',
  diskPath: '',
  temp: '',
  token: '',
  headSha: '',
}

let available = false
let db: any = null
let serve: any = null
let baseUrl = ''

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return stdout.trim()
}

const WORKFLOW = `name: Local
on:
  push:
    branches: [main]
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - name: Say hello
        run: echo "hello from the runner"
      - name: Read the checkout
        run: cat marker.txt
      - name: Pass something on
        run: |
          echo "BUILT=yes" >> "\$GITHUB_ENV"
          echo "::add-mask::topsecretvalue"
          echo "the token is topsecretvalue"
      - name: Read what the last step set
        run: |
          echo "carried: \$BUILT"
          echo "### Built it" >> "\$GITHUB_STEP_SUMMARY"
          echo "::warning file=marker.txt,line=1,title=Nit::Could say more"
      - name: Use a local action
        uses: ./.reviewos/actions/greet
        with:
          who: reviewer
      - name: Refuse an action from the internet
        uses: actions/checkout@v4
        continue-on-error: true
      - name: Produce an output
        id: build
        run: |
          echo "artifact=app.tar.gz" >> "\$GITHUB_OUTPUT"
          echo "changed=true" >> "\$GITHUB_OUTPUT"
      - name: Read the last step's output
        if: steps.build.outputs.changed == 'true'
        run: echo "built \${{ steps.build.outputs.artifact }}"
      - name: Skipped by its condition
        if: steps.build.outputs.changed == 'false'
        run: echo "this must not appear"
      - name: Runs even after a failure
        if: always()
        run: echo "always ran"
      - name: Read the environment a workflow expects
        if: always()
        run: |
          echo "repo: \$GITHUB_REPOSITORY on \$GITHUB_REF_NAME (\$GITHUB_REF_TYPE)"
          echo "workflow: \$GITHUB_WORKFLOW job: \$GITHUB_JOB run: \$GITHUB_RUN_NUMBER"
          echo "aliased: \$REVIEWOS_REPOSITORY"
      - name: Read the event payload
        if: always()
        run: |
          echo "payload: \$(cat "\$GITHUB_EVENT_PATH")"
      - name: The toolchain came from somewhere
        if: always()
        run: git --version
`

/** A composite action in the repository, which is most of what an action is. */
const ACTION = `name: Greet
description: Greets somebody
inputs:
  who:
    description: Who to greet
    default: world
runs:
  using: composite
  steps:
    - name: Greet them
      shell: bash
      run: echo "greetings, \$INPUT_WHO"
    - name: Prove the workspace is the caller's
      shell: bash
      run: cat marker.txt
`

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-local-runner-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('lr')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Local Runner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    // A workflow, and a file only a real checkout would produce.
    const work = join(created.temp, 'work')
    mkdirSync(join(work, '.reviewos', 'workflows'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    writeFileSync(join(work, '.reviewos', 'workflows', 'local.yml'), WORKFLOW)
    writeFileSync(join(work, 'marker.txt'), 'this came from the repository\n')

    /*
     * A dependency file, so the toolchain path is exercised rather than
     * skipped. This is the answer to `container: node:20` for the case that is
     * really "give me node 20", which is most of them - and the runner has to
     * behave the same whether or not the machine has pantry, because most
     * machines running this test will not.
     */
    writeFileSync(join(work, 'deps.yaml'), 'dependencies:\n  - git\n')

    mkdirSync(join(work, '.reviewos', 'actions', 'greet'), { recursive: true })
    writeFileSync(join(work, '.reviewos', 'actions', 'greet', 'action.yml'), ACTION)

    await git(work, 'add', '-A')
    await git(work, 'commit', '-m', 'a workflow and a marker')
    await git(work, 'push', created.diskPath, 'main')

    created.headSha = await git(work, 'rev-parse', 'HEAD')

    const { parseRefUpdates } = await import('../../app/Actions/Git/push')
    const { default: ProcessPushJob } = await import('../../app/Jobs/ProcessPushJob')

    await ProcessPushJob.handle({
      gitDir: created.diskPath,
      updates: parseRefUpdates(`${'0'.repeat(40)} ${created.headSha} refs/heads/main`),
    })

    /*
     * Scoped to this repository rather than to the instance.
     *
     * `runner:local --register` makes an instance-wide runner, which is right
     * for a single-tenant box and wrong for a test: an instance-wide runner
     * claims whatever queued job it finds, and a shared development database
     * has plenty from other suites. Scoping keeps this test about this
     * repository - and exercises the scope rule while it is here.
     */
    const secret = generateToken()
    const runner: any = await db.insertInto('runners')
      .values({
        name: unique('local'),
        scope_type: 'repository',
        scope_id: created.repositoryId,
        token_hash: secret.hash,
        labels: 'ubuntu-latest\nself-hosted',
        state: 'active',
        version: '1',
      })
      .returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner?.id)
    created.token = secret.token

    /*
     * The instance itself, served on a port of its own, so the runner talks to
     * it over HTTP the way any other runner would. Reaching into the database
     * instead would test a runner nobody has.
     */
    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    serve = await route.serve({ port: 0, hostname: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${Number((serve as any)?.port ?? 0)}`

    available = true
  }
  catch (error) {
    console.warn(`[runner-local] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    serve?.stop?.()
  }
  catch { /* the process is going away anyway */ }

  try {
    if (created.repositoryId) {
      await db.deleteFrom('workflow_runs').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    }

    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the files still go, below */ }

  if (created.diskPath)
    rmSync(created.diskPath, { recursive: true, force: true })

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })
})

/** Poll until a condition holds, or until the deadline passes. */
async function waitFor<T>(read: () => Promise<T>, until: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()

  while (!until(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    value = await read()
  }

  return value
}

describe('the local runner', () => {
  test('claims the queued job, runs it, and reports it succeeded', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    /*
     * Wait for the dispatcher first.
     *
     * The push is processed and the run is created by a listener, which is
     * fire-and-forget by design - so claiming immediately races it. On an idle
     * machine the race is won by accident; under a full suite it is lost, which
     * is the sort of test that gets called flaky when it is simply early.
     */
    const queued = await waitFor(
      () => db
        .selectFrom('workflow_jobs')
        .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
        .select(['workflow_jobs.id as id'])
        .where('workflow_runs.repository_id', '=', created.repositoryId)
        .execute(),
      (rows: any[]) => rows.length > 0,
    )

    expect(queued.length).toBeGreaterThan(0)

    const outcome = await runOnce({
      baseUrl,
      token: created.token,
      reposRoot: 'storage/repos',
    })

    expect(outcome).toBeTruthy()

    expect(outcome!.state).toBe('succeeded')

    const job: any = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.state as state'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(String(job.state)).toBe('succeeded')
  }, 120_000)

  test('and the logs carry what the steps printed', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .orderBy('workflow_job_logs.sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain('hello from the runner')

    /*
     * The half a workflow copied from GitHub depends on: Actions leaves the
     * checkout to `actions/checkout`, this runner does not resolve actions, so
     * it checks out first. Without it every step runs in an empty directory and
     * the product looks broken rather than incomplete.
     */
    expect(text).toContain('this came from the repository')
  }, 60_000)

  /*
   * The file protocol: a step tells the next one something by writing to a file
   * whose path is in the environment. Each step is its own process, so there is
   * no other way for `BUILT=yes` to survive - and this is what lets a workflow
   * copied from Actions behave the way its author expected.
   */
  test('what one step writes to GITHUB_ENV, the next one reads', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .orderBy('workflow_job_logs.sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain('carried: yes')
  }, 60_000)

  /*
   * Masking, which has to happen in the runner rather than on the server: a
   * value masked after it crossed the wire has already been written down.
   */
  test('a value registered with ::add-mask:: never reaches the log', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).not.toContain('topsecretvalue')
    expect(text).toContain('the token is ***')
    // The command that registered it is dropped too: logging it would publish
    // the value in the act of protecting it.
    expect(text).not.toContain('::add-mask::')
  }, 60_000)

  /*
   * The path this whole protocol exists for: a tool that knows nothing about
   * this instance prints a line, and a reviewer sees a message on line 1 of
   * `marker.txt`.
   */
  test('a ::warning file=...:: becomes a check annotation on the diff', async () => {
    if (!available)
      return

    const annotations: any[] = await db
      .selectFrom('check_annotations')
      .innerJoin('check_runs', 'check_runs.id', '=', 'check_annotations.check_run_id')
      .select([
        'check_annotations.path as path',
        'check_annotations.start_line as start_line',
        'check_annotations.level as level',
        'check_annotations.title as title',
        'check_annotations.message as message',
      ])
      .where('check_runs.repository_id', '=', created.repositoryId)
      .execute()

    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      path: 'marker.txt',
      level: 'warning',
      title: 'Nit',
      message: 'Could say more',
    })
    expect(Number(annotations[0].start_line)).toBe(1)
  }, 60_000)

  test('and the step summary lands on the check', async () => {
    if (!available)
      return

    const check: any = await db
      .selectFrom('check_runs')
      .select(['summary', 'provider', 'name'])
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(String(check.summary)).toContain('Built it')
    // Named for the job rather than the workflow: "greet failed" is useful,
    // "Local failed" is what the reader already knew.
    expect(String(check.name)).toBe('greet')
    expect(String(check.provider)).toBe('workflow')
  }, 60_000)

  /*
   * A local composite action, which is most of what an action is in practice:
   * repositories' own actions are nearly all composite, and running one needs
   * nothing this runner does not already have.
   */
  test('a local composite action runs, with its inputs and the caller\'s workspace', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .orderBy('workflow_job_logs.sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    // `with: { who: reviewer }` reached the action as INPUT_WHO.
    expect(text).toContain('greetings, reviewer')

    /*
     * And its steps ran in the *caller's* workspace rather than the action's
     * own directory - which reads as wrong until you write an action: its steps
     * operate on the repository that called them.
     */
    expect(text.split('greetings, reviewer')[1]).toContain('this came from the repository')
  }, 60_000)

  /*
   * The closed default. An action is code from somewhere else that a
   * repository's workflow runs on this instance's runners, so fetching one is
   * an operator's decision rather than a workflow author's.
   */
  test('an action from the internet is refused, with the reason in the log', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain('no default action host')
  }, 60_000)

  /*
   * Step-level `if:`, which had to wait for the runner: a condition reading
   * `steps.build.outputs.changed` cannot be answered before the step called
   * `build` has run, so it cannot be answered at dispatch at all.
   */
  test('a step\'s condition reads what the steps before it produced', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .orderBy('workflow_job_logs.sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    // The condition held, and the interpolation read the output.
    expect(text).toContain('built app.tar.gz')

    // The one whose condition did not hold says why rather than vanishing: a
    // step that silently did not run is the thing people spend an afternoon on.
    expect(text).not.toContain('this must not appear')
    expect(text).toContain('is false')
  }, 60_000)

  /*
   * `if: always()` exists to run after a failure - uploading logs, posting a
   * comment, tearing down a deployment - so a runner that stops at the first
   * failing step skips exactly the steps written for that moment.
   */
  test('and a step with if: always() runs after an earlier one failed', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain('always ran')
  }, 60_000)

  /*
   * The compatibility surface nothing else proves: a step reading the
   * variables and the payload file that every action ever written assumes are
   * there. Both fail quietly when they are missing - an action that reads an
   * unset variable does the wrong thing without complaining, and one that
   * reads an empty event payload does nothing at all - so the only way to know
   * is to have a real step print them.
   */
  test('a step finds the environment and the event payload an Actions workflow expects', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain(`repo: ${created.handle}/${created.name} on main (branch)`)
    expect(text).toContain('workflow: Local job: greet run: ')
    // The same value under this forge's own name, so a workflow can say where
    // it is running without naming somebody else's product.
    expect(text).toContain(`aliased: ${created.handle}/${created.name}`)

    const line = text.split('payload: ')[1] ?? ''

    expect(line).toContain('"event": "push"')
    expect(line).toContain(`"full_name": "${created.handle}/${created.name}"`)
    expect(line).toContain(created.headSha)
  }, 60_000)

  test('a second claim finds nothing, because the job is finished', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    expect(await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })).toBeNull()
  }, 60_000)

  /*
   * The one refusal that is not a configuration choice. Untrusted code on the
   * control plane's own host is the combination that turns a CI feature into
   * somebody else's shell, so it is refused in the runner rather than left to a
   * flag somebody can set at three in the morning.
   */
  test('refuses an untrusted run rather than executing a fork\'s code', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    const run: any = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: Number(version.id),
        repository_id: created.repositoryId,
        number: 99,
        state: 'queued',
        event: 'pull_request',
        event_ref: 'refs/pull/1/head',
        head_sha: created.headSha,
        definition_sha: created.headSha,
        // The fact that decides it.
        trusted: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'greet',
      name: 'greet',
      position: 0,
      state: 'queued',
      runs_on: 'ubuntu-latest',
    }).execute()

    const outcome = await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })

    expect(outcome).toBeTruthy()
    expect(outcome!.state).toBe('failed')
    expect(outcome!.reason).toContain('untrusted')

    // Failed rather than dropped: a run that never reaches a terminal state
    // holds a pull request's checks open with nothing to show for it.
    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['state'])
      .where('workflow_run_id', '=', Number(run.id))
      .executeTakeFirst()

    expect(String(job.state)).toBe('failed')
  }, 120_000)
})

/*
 * Job outputs: what one job produced, read by the job that waited for it.
 *
 * The whole path in one test, because every part of it is only useful with the
 * others - a runner resolving `${{ steps.build.outputs.name }}` into a value,
 * the control plane storing it against the run's job, and the next claim
 * handing it to whoever needed it.
 */
describe('outputs between jobs', () => {
  test('a dependent job is handed what the job it needed produced', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    // A version whose first job declares an output and whose second needs it.
    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    const producer: any = await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: Number(version.id),
      job_id: 'produce',
      name: 'Produce',
      position: 10,
      runs_on: 'ubuntu-latest',
      outputs: JSON.stringify({ artifact: '${{ steps.pack.outputs.name }}' }),
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_version_steps').values({
      workflow_version_job_id: Number(producer.id),
      position: 0,
      step_id: 'pack',
      name: 'Pack',
      command: 'echo "name=app-1.2.3.tgz" >> "$GITHUB_OUTPUT"',
    }).execute()

    const consumer: any = await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: Number(version.id),
      job_id: 'consume',
      name: 'Consume',
      position: 11,
      runs_on: 'ubuntu-latest',
      needs: 'produce',
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_version_steps').values({
      workflow_version_job_id: Number(consumer.id),
      position: 0,
      name: 'Read it',
      command: 'echo "got ${{ needs.produce.outputs.artifact }} from ${{ needs.produce.result }}"',
    }).execute()

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 500,
      state: 'queued',
      event: 'push',
      event_ref: 'refs/heads/outputs',
      head_sha: created.headSha,
      definition_sha: created.headSha,
      trusted: true,
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'produce',
      name: 'Produce',
      position: 0,
      state: 'queued',
      runs_on: 'ubuntu-latest',
    }).execute()

    await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'consume',
      name: 'Consume',
      position: 1,
      // Blocked until the producer succeeds, which is what `needs` means.
      state: 'blocked',
      needs: 'produce',
      runs_on: 'ubuntu-latest',
    }).execute()

    // The producer runs and resolves its declared output from its step.
    const first = await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })

    expect(first?.state).toBe('succeeded')

    const produced: any = await db
      .selectFrom('workflow_jobs')
      .select(['outputs'])
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', 'produce')
      .executeTakeFirst()

    expect(JSON.parse(String(produced.outputs))).toEqual({ artifact: 'app-1.2.3.tgz' })

    // Unblock the consumer the way the dispatcher would, then run it.
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'queued' } as any)
      .where('workflow_run_id', '=', Number(run.id))
      .where('job_id', '=', 'consume')
      .execute()

    const second = await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })

    expect(second?.state).toBe('succeeded')

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_jobs.workflow_run_id', '=', Number(run.id))
      .where('workflow_jobs.job_id', '=', 'consume')
      .orderBy('workflow_job_logs.sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    // Both halves of what `needs` carries: the value, and whether the job that
    // produced it succeeded - a dependent job's `if:` reads the second as often
    // as it reads the first.
    expect(text).toContain('got app-1.2.3.tgz from success')
  }, 180_000)
})

/*
 * What happens after a step fails, which is a question with three answers and
 * only one of them right.
 *
 * The loop does not stop at the first failure - a step with `if: always()`
 * exists to run after one - but "does not stop" cannot mean "runs everything",
 * or a job whose build broke goes on to deploy. Actions' rule is that a
 * condition naming no status function carries an implied `success() &&`, and a
 * step with no `if:` at all is exactly that case.
 */
describe('after a step fails', () => {
  test('the plain steps are skipped, the always() one runs, and the job fails', async () => {
    if (!available)
      return

    const { runOnce } = await import('../../app/Actions/Runner/localExecutor')

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.repositoryId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    const job: any = await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: Number(version.id),
      job_id: 'breaks',
      name: 'Breaks',
      position: 20,
      runs_on: 'ubuntu-latest',
    }).returning(['id']).executeTakeFirst()

    const steps = [
      { position: 0, name: 'Before', command: 'echo "before the failure"' },
      { position: 1, name: 'Break it', command: 'exit 3' },
      { position: 2, name: 'Plain step after', command: 'echo "must not appear"' },
      { position: 3, name: 'Conditional without a status function', condition: "1 == 1", command: 'echo "also must not appear"' },
      { position: 4, name: 'Cleanup', condition: 'always()', command: 'echo "cleanup ran"' },
      { position: 5, name: 'Only on failure', condition: 'failure()', command: 'echo "failure handler ran"' },
    ]

    for (const step of steps) {
      await db.insertInto('workflow_version_steps').values({
        workflow_version_job_id: Number(job.id),
        ...step,
      } as any).execute()
    }

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 600,
      state: 'queued',
      event: 'push',
      event_ref: 'refs/heads/breaks',
      head_sha: created.headSha,
      definition_sha: created.headSha,
      trusted: true,
    }).returning(['id']).executeTakeFirst()

    const runJob: any = await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'breaks',
      name: 'Breaks',
      position: 0,
      state: 'queued',
      runs_on: 'ubuntu-latest',
    }).returning(['id']).executeTakeFirst()

    const outcome = await runOnce({ baseUrl, token: created.token, reposRoot: 'storage/repos' })

    expect(outcome?.state).toBe('failed')

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .select(['content'])
      .where('workflow_job_id', '=', Number(runJob.id))
      .orderBy('sequence')
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    expect(text).toContain('before the failure')

    // The two that must not run, and the reason said out loud on the one that
    // asked a question: a skipped step with no explanation is somebody reading
    // the workflow file to work out what happened.
    expect(text).not.toContain('must not appear')
    expect(text).toContain('implies `success() &&`')

    // And the two written for this moment.
    expect(text).toContain('cleanup ran')
    expect(text).toContain('failure handler ran')
  }, 180_000)
})

/*
 * The toolchain, which is this project's answer to a container image for the
 * case that is really "give me node 22" - and which has to be a no-op rather
 * than a failure on a machine without pantry, because that is most machines.
 */
describe('a repository that declares its tools', () => {
  test('says what it is using, or says why it cannot, and runs either way', async () => {
    if (!available)
      return

    const logs: any[] = await db
      .selectFrom('workflow_job_logs')
      .innerJoin('workflow_jobs', 'workflow_jobs.id', '=', 'workflow_job_logs.workflow_job_id')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_job_logs.content as content'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .execute()

    const text = logs.map(row => String(row.content ?? '')).join('')

    // The group is opened either way, so a reader can see the decision was made
    // rather than wondering whether the feature exists.
    expect(text).toContain('Toolchain')

    /*
     * One of the two, and both are correct: pantry resolved the dependency
     * file, or the machine does not have pantry and the job carried on with
     * what it had. A step that installs its own tools is how every workflow
     * written for Actions already works.
     */
    expect(/Using .*git|pantry is not available here/.test(text)).toBe(true)

    // And the job succeeded regardless, which is the property that matters.
    expect(text).toContain('git version')
  }, 60_000)
})
