// A fork's pull request, held until somebody says it may run.
//
// The fork policy's last clause. The run already gets no secrets and no identity
// token and cannot supply its own workflow; what was missing is the part that
// stops a stranger's code from reaching a machine at all until a maintainer has
// looked at the diff.
//
// Two things this pins down. A held run is `waiting` rather than `queued`, which
// is what keeps it away from the claim - so there is no second place to get the
// hold right. And approving says "run this", not "this is ours": the run stays
// untrusted, which is the distinction behind every published secret-theft
// write-up.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { claimNextJob } from '../../app/Actions/Runner/claim'
import { splitLabels } from '../../app/Actions/Runner/protocol'
import { dispatchPullRequest } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { isTrue } from '../../app/Actions/Support/sql'

const created = {
  ownerId: 0,
  strangerId: 0,
  maintainerToken: '',
  repositoryId: 0,
  forkId: 0,
  runnerId: 0,
  handle: '',
  stranger: '',
  name: '',
}

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
`

/** Dispatch a pull request run from a fork, authored by the given user. */
async function forkRun(actorId: number, sha: string, ref: string): Promise<any> {
  await dispatchPullRequest({
    repositoryId: created.repositoryId,
    event: {
      activity: 'opened',
      baseBranch: 'main',
      headBranch: 'change',
      fromFork: true,
      draft: false,
    } as any,
    headSha: sha,
    ref,
    number: 1,
    actorId,
  })

  return db
    .selectFrom('workflow_runs')
    .select(['id', 'number', 'state', 'approval_state', 'trusted', 'conclusion_reason'])
    .where('repository_id', '=', created.repositoryId)
    .where('event_ref', '=', ref)
    .executeTakeFirst()
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['state', 'condition_reason'])
    .where('workflow_run_id', '=', runId)
    .execute()
}

async function runnerFacts(): Promise<any> {
  const row: any = await db
    .selectFrom('runners')
    .select(['id', 'state', 'scope_type', 'scope_id', 'labels'])
    .where('id', '=', created.runnerId)
    .executeTakeFirst()

  return {
    id: Number(row.id),
    state: String(row.state),
    scopeType: String(row.scope_type),
    scopeId: row.scope_id === null ? null : Number(row.scope_id),
    labels: splitLabels(row.labels),
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')
    const { createToken } = await import('@stacksjs/auth')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('fka')
    created.stranger = unique('fks')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Maintainer', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const issued: any = await createToken(created.ownerId, 'fork approval test')
    created.maintainerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    const stranger: any = await db.insertInto('users')
      .values({ name: 'Stranger', email: `${created.stranger}@example.com`, handle: created.stranger, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.strangerId = Number(stranger?.id)
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

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    } as any).returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner?.id)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[fork-approval] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute().catch(() => {})
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
    for (const id of [created.ownerId, created.strangerId])
      if (id)
        await db.deleteFrom('users').where('id', '=', id).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a first-time contributor\'s fork', () => {
  test('is held, with the reason, and no machine can take it', async () => {
    if (!available)
      return

    const run = await forkRun(created.strangerId, 'b1'.repeat(20), 'refs/pull/1/head')

    expect(run).toBeTruthy()
    expect(String(run.state)).toBe('waiting')
    expect(String(run.approval_state)).toBe('required')
    expect(String(run.conclusion_reason)).toContain('first-time')

    /*
     * The jobs read as blocked with the reason rather than queued. The run being
     * `waiting` is what keeps a machine away; this is for the person reading the
     * screen, because a list of queued jobs under a run nothing will claim is
     * somebody investigating their runners for an hour.
     */
    const jobs = await jobsOf(Number(run.id))

    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every(job => String(job.state) === 'blocked')).toBe(true)

    // And the claim offers nothing, which is the half that actually protects the
    // fleet.
    expect(await claimNextJob(await runnerFacts())).toBeNull()
  }, 120_000)

  test('runs once a maintainer says so, and is still untrusted', async () => {
    if (!available)
      return

    const before: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'number'])
      .where('repository_id', '=', created.repositoryId)
      .where('event_ref', '=', 'refs/pull/1/head')
      .executeTakeFirst()

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/approve-fork`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.maintainerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number: Number(before.number), decision: 'approve' }),
    })

    expect(answer.status).toBe(200)

    const body: any = await answer.json()

    /*
     * Approving says "run this", not "this is ours". Conflating the two is the
     * mistake behind the published secret-theft write-ups, so the answer says so
     * as well as the row.
     */
    expect(body.run.approval_state).toBe('approved')
    expect(isTrue(body.run.trusted)).toBe(false)
    expect(String(body.note)).toContain('untrusted')

    const after: any = await db
      .selectFrom('workflow_runs')
      .select(['state', 'approval_state', 'trusted', 'approved_by'])
      .where('id', '=', Number(before.id))
      .executeTakeFirst()

    expect(String(after.state)).toBe('queued')
    expect(after.trusted === false || after.trusted === 0).toBe(true)
    expect(Number(after.approved_by)).toBe(created.ownerId)

    // And now a machine may have it.
    const claim = await claimNextJob(await runnerFacts())

    expect(claim).not.toBeNull()
    expect(claim!.jobKey).toBe('test')
  }, 120_000)

  test('and a second decision is a conflict rather than a failure', async () => {
    if (!available)
      return

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['number'])
      .where('repository_id', '=', created.repositoryId)
      .where('event_ref', '=', 'refs/pull/1/head')
      .executeTakeFirst()

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/approve-fork`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.maintainerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number: Number(run.number), decision: 'approve' }),
    })

    // Two maintainers looking at the same pull request and both pressing the
    // button is ordinary, and the second one has not made a mistake.
    expect(answer.status).toBe(409)
    expect(String((await answer.json() as any).note)).toContain('already')
  }, 120_000)
})

describe('refusing one', () => {
  test('cancels it and keeps the record of who decided', async () => {
    if (!available)
      return

    const run = await forkRun(created.strangerId, 'c1'.repeat(20), 'refs/pull/3/head')

    expect(String(run.approval_state)).toBe('required')

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/workflow-runs/approve-fork`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.maintainerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, number: Number(run.number), decision: 'refuse' }),
    })

    expect(answer.status).toBe(200)

    const after: any = await db
      .selectFrom('workflow_runs')
      .select(['state', 'approval_state', 'conclusion_reason'])
      .where('id', '=', Number(run.id))
      .executeTakeFirst()

    /*
     * Cancelled and kept rather than deleted: the next person to look at the
     * pull request needs to see that a decision was made, not that nothing ever
     * ran.
     */
    expect(String(after.state)).toBe('cancelled')
    expect(String(after.approval_state)).toBe('rejected')
    expect(String(after.conclusion_reason)).toContain(created.handle)

    expect((await jobsOf(Number(run.id))).every(job => String(job.state) === 'cancelled')).toBe(true)
  }, 120_000)
})

describe('a maintainer\'s own fork branch', () => {
  test('is not held, because a push from them would run without asking', async () => {
    if (!available)
      return

    /*
     * Still an untrusted run - it is a branch in another repository - but asking
     * its author for permission is theatre when they can push here.
     */
    const run = await forkRun(created.ownerId, 'd1'.repeat(20), 'refs/pull/4/head')

    expect(String(run.approval_state)).toBe('not-required')
    expect(String(run.state)).toBe('queued')
    expect(run.trusted === false || run.trusted === 0).toBe(true)
  }, 120_000)
})
