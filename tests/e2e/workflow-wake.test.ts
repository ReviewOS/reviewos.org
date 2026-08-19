// The clock that ends a sleep.
//
// A suspended run holds no lease and no machine, which is what makes waiting
// three days affordable - and also means nothing is watching it. Everything
// here is about the sweep that is.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A run with an orchestrator job on it, in whatever state the test needs. */
async function aSleepingRun(options: { jobState?: string, runState?: string, wakeAt?: Date, orchestrator?: boolean } = {}) {
  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: Math.floor(Math.random() * 1_000_000),
    state: options.runState ?? 'running',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: 'f'.repeat(40),
    definition_sha: 'f'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  const job: any = await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    repository_id: created.repositoryId,
    job_id: 'orchestrate',
    name: 'orchestrate',
    position: 1,
    state: options.jobState ?? 'sleeping',
    orchestrator: options.orchestrator ?? true,
  }).returning(['id']).executeTakeFirst()

  const entry: any = await db.insertInto('workflow_journal_entries').values({
    workflow_run_id: Number(run.id),
    repository_id: created.repositoryId,
    sequence: 1,
    kind: 'sleep',
    identity: unique('id').padEnd(64, '0').slice(0, 64),
    name: 'approval',
    state: 'pending',
    wake_at: (options.wakeAt ?? new Date(Date.now() - 60_000)).toISOString(),
  }).returning(['id']).executeTakeFirst()

  return { runId: Number(run.id), jobId: Number(job.id), entryId: Number(entry.id) }
}

async function stateOf(jobId: number): Promise<string> {
  const row: any = await db.selectFrom('workflow_jobs').select(['state']).where('id', '=', jobId).executeTakeFirst()

  return String(row?.state ?? '')
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_journal_entries').select(['id']).limit(1).execute()

    created.handle = unique('wake')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Wake', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
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

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.reviewos/workflows/sleepy.ts',
      name: 'Sleepy',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.workflowId = Number(workflow.id)

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'f'.repeat(40),
      source_path: '.reviewos/workflows/sleepy.ts',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version.id)
    available = true
  }
  catch (error) {
    console.warn(`[wake] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!available || !db)
    return

  await db.deleteFrom('workflows').where('id', '=', created.workflowId).execute().catch(() => null)
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => null)
})

describe('a sleep that has come due', () => {
  test('puts its orchestrator back in the queue', async () => {
    if (!available)
      return

    const { wakeOne } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun()

    expect(await wakeOne(run.jobId)).toBe(true)
    expect(await stateOf(run.jobId)).toBe('queued')
  }, 120_000)

  test('and the sweep finds it without being told which run to look at', async () => {
    if (!available)
      return

    const { dueSleeps } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun()
    const due = await dueSleeps(new Date())

    expect(due.map(one => one.jobId)).toContain(run.jobId)
  }, 120_000)
})

describe('a sleep that has not', () => {
  test('is left alone, which is the whole reason it was suspended', async () => {
    if (!available)
      return

    const { dueSleeps } = await import('../../app/Actions/Workflow/wake')

    // Three days out, which is the case the suspension exists for.
    const run = await aSleepingRun({ wakeAt: new Date(Date.now() + 259_200_000) })
    const due = await dueSleeps(new Date())

    expect(due.map(one => one.jobId)).not.toContain(run.jobId)
    expect(await stateOf(run.jobId)).toBe('sleeping')
  }, 120_000)
})

describe('runs the sweep must not touch', () => {
  /**
   * The one that matters most. A person who cancelled a run while it slept has
   * already decided; waking it would restart work they stopped, which is worse
   * than a sleep that never ends.
   */
  test('a cancelled run stays cancelled', async () => {
    if (!available)
      return

    const { dueSleeps } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun({ runState: 'cancelled', jobState: 'cancelled' })
    const due = await dueSleeps(new Date())

    expect(due.map(one => one.runId)).not.toContain(run.runId)
  }, 120_000)

  test('and a job already on a machine is not taken from it', async () => {
    if (!available)
      return

    const { dueSleeps, wakeOne } = await import('../../app/Actions/Workflow/wake')

    // Running means its program is about to ask about this sleep by itself.
    const run = await aSleepingRun({ jobState: 'running' })
    const due = await dueSleeps(new Date())

    expect(due.map(one => one.jobId)).not.toContain(run.jobId)
    // And even asked directly, the guard holds: the sweep must never take work
    // from a machine that is alive.
    expect(await wakeOne(run.jobId)).toBe(false)
    expect(await stateOf(run.jobId)).toBe('running')
  }, 120_000)

  test('and a run whose sleeping job is not the orchestrator is not woken through it', async () => {
    if (!available)
      return

    const { dueSleeps } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun({ orchestrator: false })
    const due = await dueSleeps(new Date())

    expect(due.map(one => one.jobId)).not.toContain(run.jobId)
  }, 120_000)
})

describe('waking twice', () => {
  /**
   * Two sweeps overlapping, or a sweep racing a runner that just claimed the
   * job. One requeue, not two - otherwise a run gets two orchestrators, which
   * the journal survives but which nothing should be causing.
   */
  test('moves the job once', async () => {
    if (!available)
      return

    const { wakeOne } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun()

    const both = await Promise.all([wakeOne(run.jobId), wakeOne(run.jobId)])

    expect(both.filter(Boolean)).toHaveLength(1)
    expect(await stateOf(run.jobId)).toBe('queued')
  }, 120_000)
})

describe('waiting on a name rather than a time', () => {
  /**
   * The other half of "the control plane wakes it when the timer fires or the
   * event arrives". A workflow held for three days is waiting for a person, and
   * three days is only when waiting stops being reasonable.
   */
  test('an event resolves the call with its payload and requeues the orchestrator', async () => {
    if (!available)
      return

    const { deliverEvent } = await import('../../app/Actions/Workflow/wake')
    const { identityOf, record } = await import('../../app/Actions/Workflow/journal')

    const run = await aSleepingRun()

    await db.insertInto('workflow_journal_entries').values({
      workflow_run_id: run.runId,
      repository_id: created.repositoryId,
      sequence: 2,
      kind: 'event',
      identity: identityOf('event', 'approval', {}),
      name: 'approval',
      state: 'pending',
    }).execute()

    expect(await deliverEvent(run.runId, 'approval', { by: 'chris' })).toBe(true)

    // Back in the queue, so a machine picks the program up and it replays.
    expect(await stateOf(run.jobId)).toBe('queued')

    // And the call now answers with what happened, not merely that it did.
    const seen = await record({ runId: run.runId, sequence: 2, kind: 'event', name: 'approval', args: {} })

    expect(seen.decision).toBe('replay')
    expect((seen as any).result).toEqual({ by: 'chris' })
  }, 120_000)

  test('and an event nobody is waiting for is ordinary rather than an error', async () => {
    if (!available)
      return

    const { deliverEvent } = await import('../../app/Actions/Workflow/wake')

    const run = await aSleepingRun()

    expect(await deliverEvent(run.runId, 'nobody-asked', {})).toBe(false)
  }, 120_000)

  test('and delivering it twice keeps the first payload', async () => {
    if (!available)
      return

    const { deliverEvent } = await import('../../app/Actions/Workflow/wake')
    const { identityOf, record } = await import('../../app/Actions/Workflow/journal')

    const run = await aSleepingRun()

    await db.insertInto('workflow_journal_entries').values({
      workflow_run_id: run.runId,
      repository_id: created.repositoryId,
      sequence: 2,
      kind: 'event',
      identity: identityOf('event', 'approval', {}),
      name: 'approval',
      state: 'pending',
    }).execute()

    await deliverEvent(run.runId, 'approval', { by: 'first' })
    // A retried webhook, or two people clicking approve. The run already
    // continued on the first one; overwriting it would rewrite history the
    // program has acted on.
    await deliverEvent(run.runId, 'approval', { by: 'second' })

    const seen = await record({ runId: run.runId, sequence: 2, kind: 'event', name: 'approval', args: {} })

    expect((seen as any).result).toEqual({ by: 'first' })
  }, 120_000)
})
