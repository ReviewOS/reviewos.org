// A real repository's workflow directory, imported, and the run graph it makes.
//
// The fixtures are the shapes real repositories have - a matrix over runtime
// versions, a release pipeline with dependencies, a scheduled job - rather than
// files written to pass this test. What is asserted is the graph: which jobs a
// push creates, how many copies of a matrix job, and what waits on what. That
// is the thing a migration is really moving, and the thing that is wrong when a
// workflow "imported fine" and then behaves differently.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { reportOnWorkflows } from '../../app/Actions/Import/ci'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The fixture directory, read the way an import reads a checkout. */
function fixture(name: string): { path: string, source: string } {
  return {
    path: `.github/workflows/${name}`,
    source: readFileSync(join(process.cwd(), 'tests/fixtures/conformance', name), 'utf8'),
  }
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'name', 'needs', 'runs_on', 'matrix_values', 'state'])
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

    created.handle = unique('impci')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Import CI', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
    available = true
  }
  catch (error) {
    console.warn(`[import-ci] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a workflow directory carried across', () => {
  test('registers every file, and a push makes the graph the file describes', async () => {
    if (!available)
      return

    const files = ['node-ci.yml', 'release.yml', 'scheduled.yml'].map(fixture)

    for (const file of files) {
      await syncWorkflowFile({
        repositoryId: created.repositoryId,
        ownerType: 'user',
        ownerId: created.ownerId,
        path: file.path,
        source: file.source,
        sha: 'a'.repeat(40),
      })
    }

    const registered = await db
      .selectFrom('workflows')
      .select(['path', 'state'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    expect(registered).toHaveLength(3)
    expect(registered.every((one: any) => String(one.state) === 'active')).toBe(true)

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b'.repeat(40),
    })

    // `node-ci` runs on push to main; `scheduled` does not, and `release` runs
    // on a tag. A push that started all three would be the failure this asserts
    // against - a migration that makes every workflow fire on everything.
    expect(dispatched.created).toHaveLength(1)

    const jobs = await jobsOf(Number(dispatched.created[0]))

    /*
     * The matrix, expanded: `node: [20, 22]` is two jobs, which is what Actions
     * produces for the same file. One job carrying the matrix as data would
     * look identical in a listing and behave differently in every way that
     * matters - parallelism, retries, and what `needs:` waits for.
     */
    const test = jobs.filter(one => String(one.job_id) === 'test')

    expect(test).toHaveLength(2)
    expect(test.map(one => JSON.parse(String(one.matrix_values ?? '{}')).node).sort()).toEqual([20, 22])
    expect(test.every(one => String(one.runs_on).includes('ubuntu-latest'))).toBe(true)
  }, 120_000)

  test('and the release pipeline keeps what waits on what', async () => {
    if (!available)
      return

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/tags/v1.2.3' },
      headSha: 'c'.repeat(40),
    })

    expect(dispatched.created.length).toBeGreaterThan(0)

    const jobs = await jobsOf(Number(dispatched.created[0]))
    const byKey = new Map(jobs.map(one => [String(one.job_id), one]))

    // The release fixture publishes from one job into an environment, which is
    // the shape most release workflows have.
    const publish = byKey.get('publish')

    expect(publish).toBeTruthy()
    expect(String(publish.runs_on)).toContain('ubuntu-latest')

    /*
     * And it is the *only* thing a tag starts: `node-ci` filters on branches,
     * so a tag must not run it. The mirror of that - a branch push starting the
     * tag-only release workflow - is what this suite found, and it is fixed in
     * `pushStartsRun`.
     */
    expect(dispatched.created).toHaveLength(1)
  }, 120_000)

  test('and the report says what will not run before anybody pushes', async () => {
    if (!available)
      return

    const report = await reportOnWorkflows({
      repositoryId: created.repositoryId,
      files: ['node-ci.yml', 'docker.yml', 'reusable.yml'].map(fixture),
    })

    expect(report.workflows).toHaveLength(3)

    // Every real repository's workflows reference actions, and an instance with
    // no default action host configured resolves none of them - which is a
    // sentence somebody should read before the move rather than after the first
    // red run.
    expect(report.actions_needed.some(one => one.includes('default action host'))).toBe(true)

    const docker = report.workflows.find(one => one.path.endsWith('docker.yml'))

    expect(docker!.differences.length + docker!.actions.length).toBeGreaterThan(0)
  }, 120_000)
})
