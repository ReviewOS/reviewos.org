import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { authenticateRunner, hashToken } from '../../app/Actions/Runner/authenticate'
import { RUNNER_PROTOCOL } from '../../app/Actions/Runner/protocol'
import { dispatchPush, startRun } from '../../app/Actions/Workflow/dispatch'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { putSecret } from '../../app/Actions/Workflow/secrets'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { verifyWork } from '../../app/Actions/Workflow/stepSignature'
import { failJobDefinition } from '../../app/Actions/Runner/report'

const suffix = crypto.randomUUID().replaceAll('-', '')
const token = `runner-defaults-${suffix}`
const created = { ownerId: 0, repositoryId: 0, runnerId: 0 }
let db: any
let server: any
let baseURL = ''

const workflow = `name: Defaults
on: push
defaults:
  run:
    shell: bash
    working-directory: workflow-directory
jobs:
  docs:
    runs-on: defaults-test
    defaults:
      run:
        working-directory: tooling/docs
    steps:
      - run: printf inherited
      - run: printf explicit-shell
        shell: sh
      - run: printf explicit-directory
        working-directory: step-directory
      - run: printf blank-falls-through
        shell: ''
        working-directory: ''
      - uses: actions/checkout@v6
  inherited:
    runs-on: defaults-test
    steps:
      - run: printf workflow-defaults
  shell-default:
    runs-on: defaults-test
    defaults:
      run:
        shell: zsh
    steps:
      - run: printf job-shell
      - run: printf step-shell
        shell: sh
      - run: printf blank-shell
        shell: ''
      - run: printf step-directory
        working-directory: shell-job-step
`

beforeAll(async () => {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  const { route } = await import('@stacksjs/router')
  await injectGlobalAutoImports()
  db = (globalThis as any).db
  // A missing disposable database is a setup failure, never a passing test.
  await db.selectFrom('users').select(['id']).limit(1).execute()
  await route.importRoutes()
  server = await route.serve({ port: 0, hostname: '127.0.0.1' })
  baseURL = `http://127.0.0.1:${Number(server.port)}`

  const owner: any = await db.insertInto('users').values({
    name: 'Runner Defaults', email: `defaults-${suffix}@example.com`,
    handle: `dflt${suffix}`, password: 'fixture-not-a-login',
  }).returning(['id']).executeTakeFirst()
  created.ownerId = Number(owner.id)
  const repository: any = await db.insertInto('repositories').values({
    owner_type: 'user', owner_id: created.ownerId, name: `defaults${suffix}`,
    visibility: 'public', default_branch: 'main', disk_path: `defaults${suffix}/fixture.git`,
  }).returning(['id']).executeTakeFirst()
  created.repositoryId = Number(repository.id)
  const runner: any = await db.insertInto('runners').values({
    name: `defaults${suffix}`, scope_type: 'repository', scope_id: created.repositoryId,
    token_hash: hashToken(token), labels: 'defaults-test', state: 'active',
  }).returning(['id']).executeTakeFirst()
  created.runnerId = Number(runner.id)
}, 120_000)

afterAll(async () => {
  try { await server?.stop?.(true) }
  finally {
    try {
      if (created.runnerId) await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    }
    finally {
      try {
        if (created.repositoryId) await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }
      finally {
        if (created.ownerId) {
          await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute()
          await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
        }
      }
    }
  }
})

async function post(path: string, bearer = token, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseURL}/api/runner/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}`, 'X-Runner-Protocol': String(RUNNER_PROTOCOL.current) },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<any>
}

test('claims inherit run shell and directory from their immutable workflow and job, with step overrides', async () => {
  const definition = {
    repositoryId: created.repositoryId, ownerType: 'user' as const, ownerId: created.ownerId,
    path: '.github/workflows/defaults.yml',
  }
  const first = await syncWorkflowFile({ ...definition, source: workflow, sha: 'a'.repeat(40) })
  expect(first.ok, JSON.stringify(first.errors)).toBe(true)
  expect(first.createdVersion).toBe(true)
  expect(first.versionId).toBeGreaterThan(0)
  const dispatched = await dispatchPush({
    repositoryId: created.repositoryId, event: { ref: 'refs/heads/main' }, headSha: 'b'.repeat(40),
  })
  expect(dispatched.created).toHaveLength(1)
  // A later sync must not replace the defaults belonging to the queued run.
  const later = await syncWorkflowFile({
    ...definition, source: workflow.replaceAll('tooling/docs', 'new-definition').replaceAll('workflow-directory', 'new-workflow')
      .replace('shell: bash', 'shell: pwsh').replace('shell: zsh', 'shell: python'),
    sha: 'c'.repeat(40),
  })
  expect(later.ok, JSON.stringify(later.errors)).toBe(true)
  expect(later.createdVersion).toBe(true)
  expect(later.versionId).toBeGreaterThan(0)
  expect(later.versionId).not.toBe(first.versionId)

  const jobs = new Map<string, any>()
  for (let index = 0; index < 3; index++) {
    const { job } = await post('claim')
    expect(job?.run?.id).toBe(dispatched.created[0])
    expect(job?.token).toBeTruthy()
    jobs.set(job.key, job)
    // These tests inspect the dispatch contract; they execute no job commands.
    await post('report', job.token, { state: 'succeeded' })
  }

  expect(jobs.get('docs')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: 'bash', directory: 'tooling/docs' },
    { shell: 'sh', directory: 'tooling/docs' },
    { shell: 'bash', directory: 'step-directory' },
    { shell: 'bash', directory: 'tooling/docs' },
    { shell: null, directory: null },
  ])
  expect(jobs.get('inherited')?.steps[0]).toMatchObject({ shell: 'bash', working_directory: 'workflow-directory' })
  expect(jobs.get('shell-default')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: 'zsh', directory: 'workflow-directory' },
    { shell: 'sh', directory: 'workflow-directory' },
    { shell: 'zsh', directory: 'workflow-directory' },
    { shell: 'zsh', directory: 'shell-job-step' },
  ])

  await assertSignedDirectories(jobs.values())
}, 30_000)

async function runView(runId: number): Promise<any> {
  // Resolve only the fixture's public run number here; observe behavior
  // through the same run endpoint a person reading the failed job uses.
  const identity = await db.selectFrom('workflow_runs').select(['number'])
    .where('id', '=', runId).executeTakeFirst()
  expect(Number(identity?.number)).toBeGreaterThan(0)
  const query = new URLSearchParams({ owner: `dflt${suffix}`, repo: `defaults${suffix}`, number: String(identity.number) })
  const response = await fetch(`${baseURL}/api/repos/workflow-runs/show?${query}`)
  expect(response.status).toBe(200)
  return (await response.json() as any).workflow_run
}

test('claims with invalid called provenance fail and settle without retaining an undelivered lease', async () => {
  const definition = {
    repositoryId: created.repositoryId, ownerType: 'user' as const, ownerId: created.ownerId, sha: 'f'.repeat(40),
  }
  const target = await syncWorkflowFile({
    ...definition, path: '.github/workflows/invalid-target.yml',
    source: `name: Invalid provenance target
on: workflow_call
defaults:
  run:
    shell: zsh
    working-directory: original-target
jobs:
  build:
    runs-on: defaults-test
    continue-on-error: true
    reviewos:
      retry: 2
      soft-fail: true
    steps:
      - run: printf never-executed
`,
  })
  expect(target.ok, JSON.stringify(target.errors)).toBe(true)
  const middle = await syncWorkflowFile({
    ...definition, path: '.github/workflows/invalid-middle.yml',
    source: `name: Invalid provenance middle
on: workflow_call
jobs:
  inner:
    uses: ./.github/workflows/invalid-target.yml
`,
  })
  expect(middle.ok, JSON.stringify(middle.errors)).toBe(true)
  const caller = await syncWorkflowFile({
    ...definition, path: '.github/workflows/invalid-caller.yml',
    source: `name: Invalid provenance caller
on: workflow_dispatch
defaults:
  run:
    shell: bash
    working-directory: wrong-caller
jobs:
  call:
    uses: ./.github/workflows/invalid-middle.yml
`,
  })
  expect(caller.ok, JSON.stringify(caller.errors)).toBe(true)

  for (const [label, marker] of [
    ['mismatched nearest prefix', { versionId: target.versionId, prefix: 'wrong-prefix' }],
    ['missing nearest marker', null],
    ['unsafe pinned version', { versionId: Number.MAX_SAFE_INTEGER + 1, prefix: 'call/inner' }],
    ['coerced pinned version', { versionId: String(target.versionId), prefix: 'call/inner' }],
    ['missing pinned job definition', { versionId: caller.versionId, prefix: 'call/inner' }],
  ] as const) {
    const runId = await startRun({
      values: {
        workflow_version_id: caller.versionId, repository_id: created.repositoryId,
        state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
        head_sha: 'f'.repeat(40), definition_sha: 'f'.repeat(40), trusted: true,
      },
      versionId: Number(caller.versionId),
    })
    // Controlled corruption of this private fixture's metadata, never a live
    // run or its state. The outer barrier remains valid and must not be used
    // to guess a definition when the nearest barrier is inconsistent.
    const changed = await db.updateTable('workflow_jobs')
      .set({ settings: JSON.stringify(marker ? { call: marker } : {}) })
      .where('workflow_run_id', '=', runId).where('job_id', '=', 'call/inner')
      .returning(['id']).executeTakeFirst()
    expect(Number(changed?.id), label).toBeGreaterThan(0)
    const response = await fetch(`${baseURL}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Runner-Protocol': String(RUNNER_PROTOCOL.current) },
      body: '{}',
    })
    const body = await response.text()
    const view = await runView(runId)
    expect(view.jobs.find((job: any) => job.job_id === 'call/inner/build')?.state, label).toBe('failed')
    expect(view.state, label).toBe('failed')
    expect(view.jobs.find((job: any) => job.job_id === 'call/inner/build')?.error, label).toContain('definition')
    expect(response.status, label).toBe(200)
    expect(JSON.parse(body).job, label).toBeNull()
    expect(body, label).not.toContain('"token":')
    expect((await post('claim')).job, label).toBeNull()
  }
}, 30_000)

async function assertSignedDirectories(jobs: Iterable<any>): Promise<void> {
  // Verify the exact mapped payload against the instance's public key, then
  // prove the inherited directory cannot be changed after signing.
  const keysResponse = await fetch(`${baseURL}/.well-known/reviewos-step-keys.json`)
  expect(keysResponse.status).toBe(200)
  const { keys } = await keysResponse.json() as { keys: JsonWebKey[] }
  expect(keys.length).toBeGreaterThan(0)
  for (const job of jobs) {
    const work = {
      runId: Number(job.run.id), jobId: Number(job.id), matrix: job.matrix_values ?? null,
      steps: job.steps.map((step: any) => ({
        run: step.run ?? null, uses: step.uses ?? null, env: step.env ?? null,
        workingDirectory: step.working_directory ?? null,
      })),
    }
    const signed = { work, keys, signature: job.signature }
    expect((await verifyWork(signed)).ok).toBe(true)
    const tampered = {
      ...work,
      steps: work.steps.map((step: any, index: number) => index === 0
        ? { ...step, workingDirectory: 'changed-after-signing' }
        : step),
    }
    expect((await verifyWork({ ...signed, work: tampered })).ok).toBe(false)
  }
}

test('nested reusable claims keep the called version defaults without inheriting the caller defaults', async () => {
  const definition = {
    repositoryId: created.repositoryId, ownerType: 'user' as const, ownerId: created.ownerId,
  }
  const reusable = `name: Called defaults
on: workflow_call
defaults:
  run:
    shell: zsh
    working-directory: called-workflow
jobs:
  build:
    runs-on: defaults-test
    defaults:
      run:
        working-directory: called-job
    steps:
      - run: printf called-defaults
      - run: printf called-override
        shell: sh
        working-directory: called-step
      - run: printf called-blank
        shell: ''
        working-directory: ''
      - uses: actions/checkout@v6
`
  const first = await syncWorkflowFile({
    ...definition, path: '.github/workflows/called-defaults.yml', source: reusable, sha: 'd'.repeat(40),
  })
  expect(first.ok, JSON.stringify(first.errors)).toBe(true)
  expect(first.createdVersion).toBe(true)
  const empty = await syncWorkflowFile({
    ...definition, path: '.github/workflows/called-empty.yml', sha: 'd'.repeat(40),
    source: `name: Called without defaults
on: workflow_call
jobs:
  build:
    runs-on: defaults-test
    steps:
      - run: printf runner-defaults
      - uses: actions/checkout@v6
`,
  })
  expect(empty.ok, JSON.stringify(empty.errors)).toBe(true)
  const middle = await syncWorkflowFile({
    ...definition, path: '.github/workflows/called-middle.yml', sha: 'd'.repeat(40),
    source: `name: Intermediate defaults
on: workflow_call
defaults:
  run:
    shell: pwsh
    working-directory: intermediate-workflow
jobs:
  nested:
    uses: ./.github/workflows/called-defaults.yml
  empty:
    uses: ./.github/workflows/called-empty.yml
`,
  })
  expect(middle.ok, JSON.stringify(middle.errors)).toBe(true)
  const caller = await syncWorkflowFile({
    ...definition, path: '.github/workflows/defaults-caller.yml', sha: 'd'.repeat(40),
    source: `name: Caller defaults
on: workflow_dispatch
defaults:
  run:
    shell: bash
    working-directory: caller-workflow
jobs:
  call:
    uses: ./.github/workflows/called-middle.yml
`,
  })
  expect(caller.ok, JSON.stringify(caller.errors)).toBe(true)
  const runId = await startRun({
    values: {
      workflow_version_id: caller.versionId, repository_id: created.repositoryId,
      state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
      head_sha: 'd'.repeat(40), definition_sha: 'd'.repeat(40), trusted: true,
    },
    versionId: Number(caller.versionId),
  })
  expect(runId).toBeGreaterThan(0)

  const later = await syncWorkflowFile({
    ...definition, path: '.github/workflows/called-defaults.yml',
    source: reusable.replaceAll('called-job', 'later-job').replace('shell: zsh', 'shell: fish'),
    sha: 'e'.repeat(40),
  })
  expect(later.ok, JSON.stringify(later.errors)).toBe(true)
  expect(later.createdVersion).toBe(true)
  expect(later.versionId).not.toBe(first.versionId)

  const jobs = new Map<string, any>()
  for (let index = 0; index < 2; index++) {
    const { job } = await post('claim')
    expect(job?.run?.id).toBe(runId)
    expect(job?.token).toBeTruthy()
    jobs.set(job.key, job)
    await post('report', job.token, { state: 'succeeded' })
  }
  expect(jobs.get('call/nested/build')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: 'zsh', directory: 'called-job' },
    { shell: 'sh', directory: 'called-step' },
    { shell: 'zsh', directory: 'called-job' },
    { shell: null, directory: null },
  ])
  expect(jobs.get('call/empty/build')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: null, directory: null },
    { shell: null, directory: null },
  ])
  await assertSignedDirectories(jobs.values())
}, 30_000)

async function fixtureVersion(path: string, source: string, sha: string): Promise<number> {
  const version = await syncWorkflowFile({
    repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId,
    path: `.github/workflows/${path}.yml`, source, sha,
  })
  expect(version.ok, JSON.stringify(version.errors)).toBe(true)
  expect(Number(version.versionId)).toBeGreaterThan(0)
  return Number(version.versionId)
}

async function fixtureRun(versionId: number, sha: string): Promise<number> {
  return startRun({
    values: {
      workflow_version_id: versionId, repository_id: created.repositoryId,
      state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
      head_sha: sha, definition_sha: sha, trusted: true,
    },
    versionId,
  })
}

test('generated claims keep their own command fields without inheriting the uploader workflow defaults', async () => {
  const versionId = await fixtureVersion('generated-defaults', `name: Generated defaults
on: workflow_dispatch
defaults:
  run:
    shell: bash
    working-directory: uploader-only
jobs:
  seed:
    runs-on: defaults-test
    steps:
      - run: printf generate
`, '1'.repeat(40))
  const runId = await fixtureRun(versionId, '1'.repeat(40))
  const { job: seed } = await post('claim')
  expect(seed?.run?.id).toBe(runId)
  expect(seed?.key).toBe('seed')
  const upload = await post('upload', seed.token, { steps: `jobs:
  generated-empty:
    runs-on: defaults-test
    steps:
      - run: printf no-parent-defaults
      - uses: actions/checkout@v6
  generated-explicit:
    runs-on: defaults-test
    steps:
      - run: printf own-fields
        shell: zsh
        working-directory: generated-directory
      - uses: actions/checkout@v6
` })
  expect(upload.added).toHaveLength(2)
  await post('report', seed.token, { state: 'succeeded' })
  const jobs = new Map<string, any>()
  for (let index = 0; index < 2; index++) {
    const { job } = await post('claim')
    expect(job?.run?.id).toBe(runId)
    jobs.set(job.key, job)
    await post('report', job.token, { state: 'succeeded' })
  }
  expect(jobs.get('generated-empty')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: null, directory: null },
    { shell: null, directory: null },
  ])
  expect(jobs.get('generated-explicit')?.steps.map((step: any) => ({ shell: step.shell, directory: step.working_directory }))).toEqual([
    { shell: 'zsh', directory: 'generated-directory' },
    { shell: null, directory: null },
  ])
  await assertSignedDirectories(jobs.values())
}, 30_000)

test('legacy claims without run step rows read the exact direct or pinned called version', async () => {
  const called = `name: Legacy called defaults
on: workflow_call
defaults:
  run:
    shell: zsh
    working-directory: legacy-called
jobs:
  build:
    runs-on: defaults-test
    steps:
      - run: printf legacy-called
`
  await fixtureVersion('legacy-called', called, '2'.repeat(40))
  const versionId = await fixtureVersion('legacy-caller', `name: Legacy caller defaults
on: workflow_dispatch
defaults:
  run:
    shell: bash
    working-directory: legacy-caller
jobs:
  direct:
    runs-on: defaults-test
    defaults:
      run:
        working-directory: legacy-direct-job
    steps:
      - run: printf legacy-direct
  call:
    uses: ./.github/workflows/legacy-called.yml
`, '2'.repeat(40))
  const runId = await fixtureRun(versionId, '2'.repeat(40))
  const jobsInFixture = await db.selectFrom('workflow_jobs').select(['id'])
    .where('workflow_run_id', '=', runId).where('kind', '=', 'command').execute()
  expect(jobsInFixture).toHaveLength(2)
  // Model the historical format in this disposable fixture only: its immutable
  // version steps remain, but dispatch had not copied run step rows yet.
  await db.deleteFrom('workflow_steps')
    .where('workflow_job_id', 'in', jobsInFixture.map((job: any) => Number(job.id))).execute()
  await fixtureVersion('legacy-called', called.replace('shell: zsh', 'shell: fish').replaceAll('legacy-called', 'later-called'), '3'.repeat(40))
  const jobs = new Map<string, any>()
  for (let index = 0; index < 2; index++) {
    const { job } = await post('claim')
    expect(job?.run?.id).toBe(runId)
    jobs.set(job.key, job)
    await post('report', job.token, { state: 'succeeded' })
  }
  expect(jobs.get('direct')?.steps[0]).toMatchObject({ shell: 'bash', working_directory: 'legacy-direct-job', run: 'printf legacy-direct' })
  expect(jobs.get('call/build')?.steps[0]).toMatchObject({ shell: 'zsh', working_directory: 'legacy-called', run: 'printf legacy-called' })
  await assertSignedDirectories(jobs.values())
}, 30_000)

test('a delayed definition failure cannot fail a replacement claim held by the same runner', async () => {
  const versionId = await fixtureVersion('replacement-claim', `name: Replacement claim
on: workflow_dispatch
jobs:
  build:
    runs-on: defaults-test
    steps:
      - run: printf replacement
`, '4'.repeat(40))
  const runId = await fixtureRun(versionId, '4'.repeat(40))
  const { job: first } = await post('claim')
  expect(first?.run?.id).toBe(runId)
  // Expire only this fixture's exact first claim; reclaim normally over HTTP.
  await db.updateTable('workflow_jobs').set({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .where('id', '=', first.id).where('job_token_hash', '=', hashToken(first.token)).execute()
  const { job: replacement } = await post('claim')
  expect(replacement?.id).toBe(first.id)
  expect(replacement?.token).not.toBe(first.token)
  const runner = await authenticateRunner(new Request(baseURL, {
    headers: { Authorization: `Bearer ${token}` },
  }) as unknown as RequestInstance)
  expect(runner).toBeTruthy()
  // This trusted control-plane operation has no runner-wire endpoint. Its
  // public function is exercised against the real claims and database.
  const stale = await failJobDefinition(runner!.facts, { jobId: first.id, jobToken: first.token }, 'stale definition failure')
  expect(stale.ok).toBe(false)
  expect((await runView(runId)).jobs.find((job: any) => job.job_id === 'build')?.state).toBe('running')
  await post('report', replacement.token, { state: 'succeeded' })
  expect((await runView(runId)).state).toBe('succeeded')
}, 30_000)

// PostgreSQL's row lock supplies a real read/write interleaving. The other
// dialects still run every transport/defaults/lifecycle test above.
const postgres = ['postgres', 'postgresql'].includes(process.env.DB_CONNECTION || '') ? test : test.skip
postgres('a replacement committed between definition failure read and write survives without token revocation', async () => {
  const versionId = await fixtureVersion('atomic-definition-failure', `name: Atomic definition failure
on: workflow_dispatch
permissions:
  contents: read
jobs:
  build:
    runs-on: defaults-test
    steps:
      - run: printf replacement
`, '5'.repeat(40))
  const runId = await startRun({
    values: {
      workflow_version_id: versionId, repository_id: created.repositoryId, actor_id: created.ownerId,
      state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
      head_sha: '5'.repeat(40), definition_sha: '5'.repeat(40), trusted: true,
    },
    versionId,
  })
  const { job } = await post('claim')
  expect(job?.run?.id).toBe(runId)
  const apiToken = job.secrets?.REVIEWOS_JOB_TOKEN
  expect(apiToken).toBeTruthy()
  const checkApiToken = async () => {
    const query = new URLSearchParams({ owner: `dflt${suffix}`, repo: `defaults${suffix}` })
    const response = await fetch(`${baseURL}/api/repos/issues?${query}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ issues: [] })
  }
  await checkApiToken()
  expect((await runView(runId)).state).toBe('running')
  const runner = await authenticateRunner(new Request(baseURL, {
    headers: { Authorization: `Bearer ${token}` },
  }) as unknown as RequestInstance)
  expect(runner).toBeTruthy()
  const diagnostic = new SQL({
    adapter: 'postgres',
    hostname: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_DATABASE, username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD || '', max: 1,
  })
  const replacementToken = `replacement-${crypto.randomUUID()}`
  let release = () => {}
  let ready = () => {}
  const acquired = new Promise<void>(resolve => { ready = resolve })
  const unlock = new Promise<void>(resolve => { release = resolve })
  let held: Promise<unknown> | undefined
  let failure: ReturnType<typeof failJobDefinition> | undefined
  try {
    held = db.transaction(async (tx: any) => {
      // Hold the row while the handler reads its previously committed live
      // claim. This expiration remains uncommitted until replacement does.
      await tx.updateTable('workflow_jobs')
        .set({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
        .where('id', '=', job.id).where('job_token_hash', '=', hashToken(job.token)).execute()
      ready()
      await unlock
      // Commit the replacement while the old handler's terminal UPDATE waits.
      // Only this private fixture's credential/expiry change; its running
      // state and runner identity are the same on both sides of the race.
      await tx.updateTable('workflow_jobs').set({
        job_token_hash: hashToken(replacementToken),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }).where('id', '=', job.id).where('job_token_hash', '=', hashToken(job.token)).execute()
    })
    await acquired
    failure = failJobDefinition(runner!.facts, { jobId: job.id, jobToken: job.token }, 'interleaved definition failure')
    const deadline = Date.now() + 5000
    let waiting = false
    while (Date.now() < deadline) {
      // Lock metadata needs native SQL; every statement is restricted to this
      // disposable database, and the independent connection owns no writes.
      const rows = await diagnostic`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%workflow_jobs%'`
      if (Number(rows[0].n) > 0) { waiting = true; break }
      await Bun.sleep(20)
    }
    expect(waiting).toBe(true)
    release()
    await held
    expect((await failure).ok).toBe(false)
    // A stale lifecycle must neither fail the replacement nor revoke its
    // repository-scoped API credential.
    await checkApiToken()
    expect((await runView(runId)).state).toBe('running')
    await post('report', replacementToken, { state: 'succeeded' })
    expect((await runView(runId)).state).toBe('succeeded')
  }
  finally {
    release()
    await Promise.allSettled([held, failure].filter(Boolean))
    await diagnostic.close()
  }
}, 30_000)


test('a failure before the first step retains a bounded redacted job error', async () => {
  const secret = `private-defaults-${crypto.randomUUID()}`
  await putSecret({ scope: 'repository', scopeId: created.repositoryId, key: 'DEFAULTS_REPORT_SECRET', value: secret })
  const synced = await syncWorkflowFile({
    repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId, path: '.github/workflows/pre-step-error.yml',
    source: `name: Pre-step error
on: workflow_dispatch
jobs:
  setup:
    runs-on: defaults-test
    steps:
      - run: printf never-started
`,
    sha: '7'.repeat(40),
  })
  expect(synced.ok, JSON.stringify(synced.errors)).toBe(true)
  for (const detail of [`Checkout failed: ${secret}`, `Checkout failed: ${secret} ${'x'.repeat(3000)}`]) {
    const runId = await startRun({
      values: {
        workflow_version_id: synced.versionId, repository_id: created.repositoryId,
        state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
        head_sha: '7'.repeat(40), definition_sha: '7'.repeat(40), trusted: true,
      },
      versionId: Number(synced.versionId),
    })
    const { job } = await post('claim')
    expect(job.run.id).toBe(runId)
    const result = await post('report', job.token, {
      job_id: job.id, state: 'failed', error: detail,
    })
    expect(result.recorded).toBe(true)
    const view = await runView(runId)
    const failed = view.jobs.find((entry: any) => entry.id === job.id)
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain(detail.length > 2000 ? 'over the 2000' : 'Checkout failed:')
    expect(failed.error).not.toContain(secret)
    expect(failed.error.length).toBeLessThanOrEqual(2000)
    const attempts = await db.selectFrom('workflow_step_attempts')
      .innerJoin('workflow_steps', 'workflow_steps.id', '=', 'workflow_step_attempts.workflow_step_id')
      .select(['workflow_step_attempts.id']).where('workflow_steps.workflow_job_id', '=', job.id).execute()
    expect(attempts).toHaveLength(0)
  }
}, 30_000)


async function environmentDeliveryFixture(waitMinutes = 0) {
  const name = `gate-${crypto.randomUUID()}`
  const environment = await db.insertInto('environments').values({
    repository_id: created.repositoryId, name, branches: 'main',
    wait_minutes: waitMinutes, require_checks: false,
  }).returning(['id']).executeTakeFirst()
  const value = `synthetic-gate-value-${name}`
  await putSecret({ scope: 'environment', scopeId: Number(environment.id), key: 'GATE_DELIVERY_KEY', value })
  const definition = await syncWorkflowFile({
    repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId,
    path: `.reviewos/workflows/${name}.yml`,
    source: `name: Environment delivery
on: workflow_dispatch
jobs:
  verify:
    runs-on: defaults-test
    environment: ${name}
    reviewos:
      secrets: [GATE_DELIVERY_KEY]
    steps:
      - run: echo fixture-only
`,
  })
  expect(definition.ok, JSON.stringify(definition.errors)).toBe(true)
  const runId = await startRun({
    values: {
      workflow_version_id: definition.versionId, repository_id: created.repositoryId,
      state: 'queued', event: 'workflow_dispatch', event_ref: 'refs/heads/main',
      head_sha: 'e'.repeat(40), definition_sha: 'e'.repeat(40), trusted: true,
    },
    versionId: Number(definition.versionId),
  })
  const job = await db.selectFrom('workflow_jobs').select(['id', 'approved_at', 'state', 'started_at'])
    .where('workflow_run_id', '=', runId).executeTakeFirst()
  return { environmentId: Number(environment.id), value, runId, job }
}

test('delivers scoped secrets after environment policy passes without fabricating a human approval', async () => {
  const fixture = await environmentDeliveryFixture()
  expect(fixture.job.state).toBe('queued')
  expect(fixture.job.approved_at).toBeNull()
  const { job } = await post('claim')
  expect(job?.run?.id).toBe(fixture.runId)
  try {
    expect(job?.secrets?.GATE_DELIVERY_KEY).toBe(fixture.value)
    const stored = await db.selectFrom('workflow_jobs').select(['approved_at', 'approved_by_id']).where('id', '=', fixture.job.id).executeTakeFirst()
    expect(stored.approved_at).toBeNull()
    expect(stored.approved_by_id).toBeNull()
  }
  finally { if (job?.token) await post('report', job.token, { state: 'succeeded' }) }
})

test('keeps an elapsed environment wait elapsed when the runner claims it', async () => {
  const fixture = await environmentDeliveryFixture(1)
  const readyAt = new Date(Date.now() - 120000).toISOString()
  await db.updateTable('workflow_jobs').set({ started_at: readyAt }).where('id', '=', fixture.job.id).execute()
  await settleRun(fixture.runId)
  const { job } = await post('claim')
  expect(job?.run?.id).toBe(fixture.runId)
  try {
    expect(job?.secrets?.GATE_DELIVERY_KEY).toBe(fixture.value)
    const stored = await db.selectFrom('workflow_jobs').select(['started_at']).where('id', '=', fixture.job.id).executeTakeFirst()
    expect(new Date(stored.started_at).getTime()).toBe(new Date(readyAt).getTime())
  }
  finally { if (job?.token) await post('report', job.token, { state: 'succeeded' }) }
})

test('refuses delivery when environment branch protection changes after enqueue', async () => {
  const fixture = await environmentDeliveryFixture()
  await db.updateTable('environments').set({ branches: 'release' }).where('id', '=', fixture.environmentId).execute()
  const result = await post('claim')
  try {
    expect(result.job).toBeNull()
    const stored = await db.selectFrom('workflow_jobs').select(['state', 'error']).where('id', '=', fixture.job.id).executeTakeFirst()
    expect(stored.state).toBe('failed')
    expect(stored.error).toContain('may not deploy')
  }
  finally { if (result.job?.token) await post('report', result.job.token, { state: 'succeeded' }) }
})
