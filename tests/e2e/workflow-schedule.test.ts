// `on: schedule`, which was stored on every version and read by nothing.
//
// A workflow with a cron expression registered it, showed it, and never ran.
// A nightly job is exactly the kind of thing somebody sets up once and does not
// check, so it is the trigger where silence costs the most.
//
// The cases here are the ones that decide whether a schedule can be trusted: it
// fires when it is due, it does not fire the moment it is added, it does not
// fire twice when two sweeps race, and a week of downtime does not become a
// week of runs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function runsHere(): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .select(['id', 'event', 'event_ref', 'head_sha', 'trusted', 'state'])
    .where('repository_id', '=', created.repositoryId)
    .orderBy('id')
    .execute()
}

/** Put the sweep's clock back, so the next sweep sees the window as unswept. */
async function lastSweptAt(when: Date | null): Promise<void> {
  await db
    .updateTable('workflows')
    .set({ last_scheduled_at: when ? when.toISOString() : null } as any)
    .where('id', '=', created.workflowId)
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('sch')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Scheduled', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        path: '.github/workflows/nightly.yml',
        name: 'Nightly',
        state: 'active',
      })
      .returning(['id']).executeTakeFirst()
    created.workflowId = Number(workflow?.id)

    const version: any = await db.insertInto('workflow_versions')
      .values({
        workflow_id: created.workflowId,
        source_sha: 'a'.repeat(40),
        source_path: '.github/workflows/nightly.yml',
        content_digest: unique('digest'),
        // Every minute, so a test does not have to wait for 03:00.
        schedules: '* * * * *',
      })
      .returning(['id']).executeTakeFirst()
    created.versionId = Number(version?.id)

    await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: created.versionId,
      job_id: 'nightly',
      name: 'Nightly',
      position: 0,
      runs_on: 'ubuntu-latest',
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[workflow-schedule] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!db || !created.repositoryId)
    return

  await db.deleteFrom('workflow_runs').where('repository_id', '=', created.repositoryId).execute().catch(() => {})
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
})

describe('the schedule sweep', () => {
  test('does not fire a workflow it has never swept', async () => {
    if (!available)
      return

    // Adding a nightly workflow and having it run the moment you push it looks
    // like a bug even when the cron says 03:00. The first sweep records the
    // clock and waits for the next occurrence.
    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    const result = await sweepSchedules()

    expect(result.created).toBe(0)
    expect(await runsHere()).toHaveLength(0)

    const workflow: any = await db.selectFrom('workflows').select(['last_scheduled_at'])
      .where('id', '=', created.workflowId).executeTakeFirst()

    expect(workflow.last_scheduled_at).toBeTruthy()
  })

  test('and fires one whose cron came due since the last sweep', async () => {
    if (!available)
      return

    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    await lastSweptAt(new Date(Date.now() - 5 * 60_000))

    const result = await sweepSchedules()

    expect(result.created).toBe(1)

    const runs = await runsHere()

    expect(runs).toHaveLength(1)
    expect(runs[0].event).toBe('schedule')
    // The default branch, the way Actions does it: a cron on a feature branch
    // would be a job nobody is watching, from a definition nobody reviewed.
    expect(runs[0].event_ref).toBe('refs/heads/main')
    // The repository's own definition on its own branch, and nobody typed
    // anything: there is no untrusted tree in this path.
    expect(runs[0].trusted).toBe(true)
  })

  test('the run carries the jobs the definition declared', async () => {
    if (!available)
      return

    const runs = await runsHere()
    const jobs = await db.selectFrom('workflow_jobs').select(['job_id', 'state'])
      .where('workflow_run_id', '=', Number(runs[0].id)).execute()

    expect(jobs).toHaveLength(1)
    expect(jobs[0].state).toBe('queued')
  })

  /*
   * The compare-and-swap, which is what actually stops a double fire: a
   * scheduled run repeats at the same ref and the same commit by design, so the
   * run table's unique index cannot tell a second night from a duplicate.
   */
  test('two sweeps racing produce one run, not two', async () => {
    if (!available)
      return

    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    await lastSweptAt(new Date(Date.now() - 5 * 60_000))

    const before = (await runsHere()).length
    const [first, second] = await Promise.all([sweepSchedules(), sweepSchedules()])

    expect(first.created + second.created).toBe(1)
    expect((await runsHere()).length).toBe(before + 1)
  })

  test('a sweep with nothing due creates nothing', async () => {
    if (!available)
      return

    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    const before = (await runsHere()).length

    // Swept a second ago: a minutely cron has not come round again.
    await lastSweptAt(new Date(Date.now() - 1000))

    const result = await sweepSchedules()

    expect(result.created).toBe(0)
    expect((await runsHere()).length).toBe(before)
  })

  /*
   * An instance that was off for a week must not wake up and fire seven nightly
   * runs. Nobody wants the backlog, and the seventh is the only one whose
   * result anybody would read.
   */
  test('a week of downtime is one catch-up run, not a week of them', async () => {
    if (!available)
      return

    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    const before = (await runsHere()).length

    await lastSweptAt(new Date(Date.now() - 7 * 24 * 60 * 60_000))

    const result = await sweepSchedules()

    expect(result.created).toBe(1)
    expect((await runsHere()).length).toBe(before + 1)
  })

  test('a workflow that is not active is not swept', async () => {
    if (!available)
      return

    const { sweepSchedules } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    await db.updateTable('workflows').set({ state: 'disabled' } as any).where('id', '=', created.workflowId).execute()
    await lastSweptAt(new Date(Date.now() - 5 * 60_000))

    const before = (await runsHere()).length
    const result = await sweepSchedules()

    expect(result.created).toBe(0)
    expect((await runsHere()).length).toBe(before)

    await db.updateTable('workflows').set({ state: 'active' } as any).where('id', '=', created.workflowId).execute()
  })
})

describe('deciding what is due', () => {
  test('an occurrence inside the window counts, and one outside does not', async () => {
    const { isDue } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    const until = new Date('2026-03-01T03:00:30Z')

    // 03:00 fell between these two sweeps.
    expect(isDue(['0 3 * * *'], new Date('2026-03-01T02:59:00Z'), until)).toBe(true)
    // And 03:00 already happened before this window opened.
    expect(isDue(['0 3 * * *'], new Date('2026-03-01T03:00:30Z'), new Date('2026-03-01T03:01:00Z'))).toBe(false)
  })

  test('several expressions are any of them, which is how Actions reads a list', async () => {
    const { isDue } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    const after = new Date('2026-03-01T02:59:00Z')
    const until = new Date('2026-03-01T03:00:30Z')

    expect(isDue(['0 9 * * *', '0 3 * * *'], after, until)).toBe(true)
    expect(isDue(['0 9 * * *', '0 21 * * *'], after, until)).toBe(false)
  })

  test('nonsense is not due rather than an error', async () => {
    // A workflow whose cron cannot be parsed should not take the sweep down
    // with it, and every other repository's schedule with that.
    const { isDue } = await import('../../app/Jobs/DispatchScheduledWorkflowsJob')

    expect(isDue(['not a cron'], new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'))).toBe(false)
  })
})
