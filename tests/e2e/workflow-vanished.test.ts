// Runs of a workflow the newer commit deleted or renamed.
//
// A newer push already skips queued runs of the same workflow through its
// concurrency group. On 2026-10-31 HQ renamed `lsu-native-*.yml` to
// `enterprise-native-*.yml`, and the old runs - with no newer run in their
// group to replace them - held the only Mac runner ahead of the real ones.
// These pin the rule that retires them, and the two guards that keep it from
// cancelling work it should not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'
import { supersedeVanishedWorkflows, vanishedRuns } from '../../app/Actions/Workflow/vanished'

const created = { ownerId: 0, repositoryId: 0 }

let available = false
let db: any = null

const KEPT = '.reviewos/workflows/enterprise-native-voice.yml'
const RENAMED = '.reviewos/workflows/lsu-native-voice.yml'
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const workflow = (name: string) => `name: ${name}
on: push
jobs:
  voice:
    runs-on: macos-arm64
    steps:
      - run: bun test
`

async function runsAt(sha: string): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .select(['workflow_runs.number as number', 'workflow_runs.state as state', 'workflow_runs.conclusion_reason as reason', 'workflow_versions.source_path as path'])
    .where('workflow_runs.repository_id', '=', created.repositoryId)
    .where('workflow_runs.head_sha', '=', sha)
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const handle = unique('vnw')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Vanished', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.ownerId = Number(owner?.id)

    const name = unique('repo')
    const repository: any = await db.insertInto('repositories')
      .values({ owner_type: 'user', owner_id: created.ownerId, name, visibility: 'public', default_branch: 'main', disk_path: `${handle}/${name}.git` })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    for (const [path, title] of [[RENAMED, 'lsu voice'], [KEPT, 'enterprise voice']]) {
      await syncWorkflowFile({ repositoryId: created.repositoryId, ownerType: 'user', ownerId: created.ownerId, path, source: workflow(title), sha: OLD })
    }

    await dispatchPush({ repositoryId: created.repositoryId, event: { ref: 'refs/heads/main' }, headSha: OLD })

    available = (await runsAt(OLD)).length === 2
  }
  catch (error) {
    console.warn(`[workflow-vanished] skipping: ${error instanceof Error ? error.message : String(error)}`)
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* fresh names next time */ }
})

describe('the rules, without a database', () => {
  const live = [
    { number: 1, headSha: OLD, path: RENAMED },
    { number: 2, headSha: OLD, path: KEPT },
    { number: 3, headSha: NEW, path: RENAMED },
  ]

  test('only a run behind the new head whose file the new head lacks', async () => {
    const stale = await vanishedRuns(live, { headSha: NEW, present: [KEPT], isAncestor: async sha => sha === OLD })

    expect(stale.map(run => run.number)).toEqual([1])
  })

  test('an older push landing late does not cancel a newer run', async () => {
    // The newer run's commit is not behind the older head.
    const stale = await vanishedRuns(live, { headSha: OLD, present: [RENAMED], isAncestor: async () => false })

    expect(stale).toEqual([])
  })

  test('an unknown tree supersedes nothing', async () => {
    expect(await vanishedRuns(live, { headSha: NEW, present: null, isAncestor: async () => true })).toEqual([])
  })
})

describe('against the database', () => {
  test('nothing moves when the old commit is not behind the new head', async () => {
    if (!available)
      return

    const cancelled = await supersedeVanishedWorkflows({
      repositoryId: created.repositoryId, ref: 'refs/heads/main', headSha: NEW, present: [KEPT], isAncestor: async () => false,
    })

    expect(cancelled).toEqual([])
    expect((await runsAt(OLD)).every(run => run.state === 'queued')).toBe(true)
  })

  test('a renamed workflow\'s queued run is skipped, and the kept one is not', async () => {
    if (!available)
      return

    const cancelled = await supersedeVanishedWorkflows({
      repositoryId: created.repositoryId, ref: 'refs/heads/main', headSha: NEW, present: [KEPT], isAncestor: async sha => sha === OLD,
    })

    const runs = await runsAt(OLD)
    const renamed = runs.find(run => run.path === RENAMED)
    const kept = runs.find(run => run.path === KEPT)

    expect(cancelled).toEqual([Number(renamed.number)])
    expect(renamed.state).toBe('cancelled')
    expect(String(renamed.reason)).toBe(`Skipped: a newer commit (bbbbbbbbb) no longer has \`${RENAMED}\`.`)
    expect(kept.state).toBe('queued')

    const jobs: any[] = await db.selectFrom('workflow_jobs').innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.state as state'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .where('workflow_runs.number', '=', Number(renamed.number))
      .execute()
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every(job => job.state === 'cancelled')).toBe(true)
  })
})
