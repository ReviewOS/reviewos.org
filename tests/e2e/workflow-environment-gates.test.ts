// `environment:` against the real tables.
//
// The unit tests hold the rules; this holds the thing that was actually wrong
// before it was written. The parser accepted `environment: production`, stored
// it, and ran the job - so a workflow said the deploy was protected, the run
// screen showed an environment, and nothing at all was enforced. That is worse
// than refusing the key, because everybody involved believes the opposite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { releaseElapsedWaits } from '../../app/Actions/Workflow/releaseWaits'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, reviewerId: 0, repositoryId: 0, handle: '', reviewer: '', name: '', environmentId: 0 }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const SHIP = `name: Ship
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    environment: production
    steps:
      - run: ./deploy
`

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'condition_reason', 'settings', 'approved_at'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

function jobNamed(rows: any[], key: string): any {
  return rows.find(row => String(row.job_id) === key)
}

/**
 * A run of the ship workflow on one ref, with its build already finished.
 *
 * Every call uses a fresh commit, because the dispatcher deduplicates by event
 * and sha - two runs of the same push are a redelivered webhook, not two runs.
 * Reusing one here quietly handed the second test the first test's run.
 */
async function runTo(ref: string): Promise<number> {
  const result = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref },
    headSha: unique('b').padEnd(40, '0').slice(0, 40),
  })

  const runId = Number(result.created[0])

  const build = jobNamed(await jobsOf(runId), 'build')

  await db
    .updateTable('workflow_jobs')
    .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
    .where('id', '=', Number(build.id))
    .execute()

  await settleRun(runId)

  return runId
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('env')
    created.reviewer = unique('rev')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Environment Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const reviewer: any = await db
      .insertInto('users')
      .values({ name: 'The Reviewer', email: `${created.reviewer}@example.com`, handle: created.reviewer, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.reviewerId = Number(reviewer?.id)
    created.name = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ship.yml',
      source: SHIP,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[environment-gates] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    for (const id of [created.ownerId, created.reviewerId]) {
      if (id)
        await db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('a job naming an environment', () => {
  test('runs when the repository has no such environment', async () => {
    if (!available)
      return

    /*
     * `environment: staging` in a repository with no `staging` is a label a
     * workflow author used for their own documentation. Refusing it would
     * break most workflows that use the key at all.
     */
    const runId = await runTo('refs/heads/main')

    expect(String(jobNamed(await jobsOf(runId), 'deploy').state)).toBe('queued')
  }, 120_000)

  test('but holds once the environment requires a reviewer', async () => {
    if (!available)
      return

    const environment: any = await db
      .insertInto('environments')
      .values({ repository_id: created.repositoryId, name: 'production', wait_minutes: 0, branches: 'main' } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.environmentId = Number(environment?.id)

    await db
      .insertInto('environment_reviewers')
      .values({ environment_id: created.environmentId, user_id: created.reviewerId } as any)
      .execute()

    const runId = await runTo('refs/heads/main')
    const deploy = jobNamed(await jobsOf(runId), 'deploy')

    expect(String(deploy.state)).toBe('paused')

    // The reason is on the job, where somebody looking at a stuck run is
    // already looking - not in a log they would have to know to open.
    expect(String(deploy.condition_reason)).toContain('needs an approval')
  }, 120_000)

  test('and a branch outside the policy is refused rather than held', async () => {
    if (!available)
      return

    /*
     * Waiting for an approval that must not be given is worse than a clear no,
     * and a reviewer repeatedly asked to approve deploys from the wrong branch
     * will eventually approve one.
     */
    const runId = await runTo('refs/heads/spike')
    const deploy = jobNamed(await jobsOf(runId), 'deploy')

    expect(String(deploy.state)).toBe('failed')
    expect(String(deploy.condition_reason)).toContain('may not deploy to production')
  }, 120_000)
})

describe('the wait timer', () => {
  test('holds an approved deploy until it elapses, then lets go on its own', async () => {
    if (!available)
      return

    await db
      .updateTable('environments')
      .set({ wait_minutes: 10 } as any)
      .where('id', '=', created.environmentId)
      .execute()

    await db.deleteFrom('environment_reviewers').where('environment_id', '=', created.environmentId).execute()

    const runId = await runTo('refs/heads/main')
    const deploy = jobNamed(await jobsOf(runId), 'deploy')

    expect(String(deploy.state)).toBe('paused')
    expect(String(deploy.condition_reason)).toContain('holds a deploy for 10 minutes')

    /*
     * A sweep now changes nothing: the timer is what holds it, and a sweep
     * that released a job early would make the window a decoration.
     */
    await releaseElapsedWaits()

    expect(String(jobNamed(await jobsOf(runId), 'deploy').state)).toBe('paused')

    // Wound back so the timer has run out, which is the only way to test a
    // clock without waiting on one.
    await db
      .updateTable('workflow_jobs')
      .set({ started_at: new Date(Date.now() - 60 * 60_000).toISOString() } as any)
      .where('id', '=', Number(deploy.id))
      .execute()

    await releaseElapsedWaits(new Date(Date.now() + 11 * 60_000))

    expect(String(jobNamed(await jobsOf(runId), 'deploy').state)).toBe('queued')
  }, 120_000)
})
