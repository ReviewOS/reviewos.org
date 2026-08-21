// A push that starts a run, and the second delivery of it that does not.
//
// Written because `dispatchPush` shipped without one, and the query it opens
// with had a three-argument `innerJoin` that this builder does not have - a
// runtime failure the typecheck accepted and nothing else exercised. Every
// claim below is about rows, so it runs against the real tables.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { isTrue } from '../../app/Actions/Support/sql'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const HEAD = 'a'.repeat(40)

const CI = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: bun run build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`

async function store(source: string, path: string) {
  return syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path,
    source,
    sha: HEAD,
  })
}

async function push(ref = 'refs/heads/main', changed?: string[], headSha = HEAD) {
  return dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref, changed },
    headSha,
  })
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state', 'needs', 'runs_on', 'position'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('wfd')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Dispatch', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the workflow dispatch end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    available = true
  }
  catch (error) {
    console.warn(`[workflow-dispatch] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('a push that matches', () => {
  test('creates one run, with the jobs the definition describes', async () => {
    if (!available)
      return

    await store(CI, '.github/workflows/ci.yml')

    const result = await push()

    expect(result.created.length).toBe(1)
    expect(result.duplicates).toBe(0)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['state', 'event', 'event_ref', 'head_sha', 'definition_sha', 'trusted', 'number'])
      .where('id', '=', result.created[0])
      .executeTakeFirst()

    expect(run.state).toBe('queued')
    expect(run.event).toBe('push')
    expect(run.event_ref).toBe('refs/heads/main')
    expect(run.head_sha).toBe(HEAD)
    expect(isTrue(run.trusted)).toBe(true)
    expect(Number(run.number)).toBe(1)
  })

  /*
   * The graph, expressed as state rather than as queue timing: a job with
   * `needs:` must not be handed out, and modelling that as "queued but ignored"
   * is how a dispatcher ends up encoding dependencies in dispatch order.
   */
  test('and the job waiting on another starts blocked', async () => {
    if (!available)
      return

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    const jobs = await jobsOf(Number(run.id))

    expect(jobs.map(job => [job.job_id, job.state])).toEqual([
      ['build', 'queued'],
      ['test', 'blocked'],
    ])
    expect(jobs[1].needs).toBe('build')
  })

  /*
   * The redelivered webhook. Two deliveries of the same push arriving together
   * would both pass a check-then-insert, so the unique index is what actually
   * enforces this - and the second delivery has to be *harmless*, not an error.
   */
  test('the same push delivered twice does not make a second run', async () => {
    if (!available)
      return

    const before: any = await db
      .selectFrom('workflow_runs')
      .select(db.fn.countAll().as('n'))
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    const result = await push()

    expect(result.created.length).toBe(0)
    expect(result.duplicates).toBe(1)

    const after: any = await db
      .selectFrom('workflow_runs')
      .select(db.fn.countAll().as('n'))
      .where('repository_id', '=', created.repositoryId)
      .executeTakeFirst()

    expect(Number(after.n)).toBe(Number(before.n))
  })

  test('but a push of a different commit does', async () => {
    if (!available)
      return

    const result = await push('refs/heads/main', undefined, 'b'.repeat(40))

    expect(result.created.length).toBe(1)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['number'])
      .where('id', '=', result.created[0])
      .executeTakeFirst()

    // Numbered per repository, so a person can say "run 2" and be understood.
    expect(Number(run.number)).toBe(2)
  })
})

/*
 * The window between the run row and the graph under it, which used to be
 * open.
 *
 * `createRunWithGraph` writes both in one transaction, and the claim query -
 * `queued` jobs of `queued` runs - is the reader that made that necessary: a
 * run visible with one of its four jobs inserted is a run a machine can take
 * work from, finish, and have the settler conclude green before the jobs it was
 * gating existed. The acceptance suite met the same window from the other side
 * and read `['lint']` where the file describes four jobs.
 *
 * So this watches for the run *while the dispatch is still running* and counts
 * its jobs the instant it can see it. Every sighting must already be the whole
 * graph. The observer is on the pooled handle and the writer is in a
 * transaction, which is the pair that has to hold.
 */
describe('while a run is being written', () => {
  test('it is not visible until the whole graph is', async () => {
    if (!available)
      return

    const path = '.github/workflows/atomic.yml'

    await store(CI, path)

    const highest: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    const before = Number(highest?.id ?? 0)

    // What each sighting of the new run had under it. A run seen with fewer
    // jobs than the definition describes is the failure this test is for.
    const sightings: number[] = []

    let settled = false

    const dispatching = push('refs/heads/main', undefined, '1'.repeat(40))
      .finally(() => {
        settled = true
      })

    /*
     * No delay in the loop: the whole point is to look as often as possible
     * during the write. It ends when the dispatch does, so a push that creates
     * nothing cannot hang the suite.
     */
    while (!settled) {
      const appeared: any = await db
        .selectFrom('workflow_runs')
        .select(['id'])
        .where('repository_id', '=', created.repositoryId)
        .where('id', '>', before)
        .orderBy('id', 'desc')
        .executeTakeFirst()

      if (!appeared)
        continue

      sightings.push((await jobsOf(Number(appeared.id))).length)
    }

    const result = await dispatching

    expect(result.created.length).toBe(2)

    for (const jobs of sightings)
      expect(jobs).toBeGreaterThanOrEqual(2)

    // And the finished state, which holds whether or not the loop above ever
    // caught the run mid-write.
    const jobs = await jobsOf(result.created[0])

    expect(jobs.map(job => String(job.job_id)).sort()).toEqual(['build', 'test'])
  })

  /*
   * The steps, which are the part a mistake here would lose quietly.
   *
   * Every job's steps are copied inside the same transaction as the job row.
   * A copy that ran on the pooled handle instead would be inserting against a
   * `workflow_job_id` that is not committed yet - a foreign key failure, on a
   * path that used to swallow its own errors - and the result would be a run
   * whose jobs all look right and do nothing.
   */
  test('and every job it wrote has its steps', async () => {
    if (!available)
      return

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'job_id'])
      .where('workflow_run_id', '=', Number(run.id))
      .execute()

    expect(jobs.length).toBeGreaterThan(0)

    for (const job of jobs) {
      const steps = await db
        .selectFrom('workflow_steps')
        .select(['id'])
        .where('workflow_job_id', '=', Number(job.id))
        .execute()

      expect([String(job.job_id), steps.length]).toEqual([String(job.job_id), 1])
    }
  })
})

describe('a push that does not match', () => {
  test('starts nothing, and says why', async () => {
    if (!available)
      return

    const result = await push('refs/heads/other', undefined, 'c'.repeat(40))

    expect(result.created.length).toBe(0)
    expect(result.skipped.length).toBeGreaterThan(0)
    expect(result.skipped[0]?.reason).toContain('branch')
  })

  test('and a tag does not run a workflow that filters branches', async () => {
    if (!available)
      return

    const result = await push('refs/tags/v1.0.0', undefined, 'd'.repeat(40))

    expect(result.created.length).toBe(0)
    expect(result.skipped[0]?.reason).toContain('tag')
  })
})

describe('when a workflow is edited twice before a push', () => {
  /*
   * Only the newest version runs. Two versions of one workflow both dispatching
   * would give a repository two runs of the same CI for one push, and the older
   * definition is one nobody asked to run.
   */
  test('only the newest version starts a run', async () => {
    if (!available)
      return

    const path = '.github/workflows/edited.yml'
    const first = await store(CI, path)
    const second = await store(CI.replace('bun test', 'bun test --coverage'), path)

    expect(second.versionId).not.toBe(first.versionId)

    const result = await push('refs/heads/main', undefined, 'e'.repeat(40))
    const versions = await db
      .selectFrom('workflow_runs')
      .select(['workflow_version_id'])
      .where('id', 'in', result.created)
      .execute()

    const started = versions.map((row: any) => Number(row.workflow_version_id))
    expect(started).toContain(second.versionId)
    expect(started).not.toContain(first.versionId)
  })
})
