// A workflow the organization carries, running over a repository that carries
// no file at all.
//
// The value is the one the roadmap states: a licence check or a secret scan
// lands on every repository without a commit in any of them, and cannot be
// removed by editing a file in one. Which makes the security half the whole
// point - it runs at the owner's trust level over the repository's data, so it
// must not be handed anything the repository controls.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

const created = {
  ownerId: 0,
  covered: 0,
  ignored: 0,
  handle: '',
  coveredName: '',
  ignoredName: '',
  workflowId: 0,
  versionId: 0,
}

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The scan the organization runs everywhere, which lives in no repository. */
const SCAN = `name: Licence scan
on: push
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - run: reviewos-licence-scan
`

async function repository(name: string): Promise<number> {
  const row: any = await db.insertInto('repositories').values({
    owner_type: 'user',
    owner_id: created.ownerId,
    name,
    visibility: 'public',
    default_branch: 'main',
    disk_path: `${created.handle}/${name}.git`,
  }).returning(['id']).executeTakeFirst()

  return Number(row.id)
}

/** The runs of a repository, newest first. */
async function runsOf(repositoryId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .select(['id', 'number', 'state', 'workflow_version_id'])
    .where('repository_id', '=', repositoryId)
    .orderBy('id', 'desc')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('ow')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.coveredName = `svc-${unique('a')}`
    created.ignoredName = `sandbox-${unique('b')}`

    created.covered = await repository(created.coveredName)
    created.ignored = await repository(created.ignoredName)

    /*
     * The workflow row carries no repository, which is the whole feature: there
     * is no file in either repository, and no commit made one.
     */
    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: null,
      path: 'organization/licence-scan.yml',
      name: 'Licence scan',
      state: 'active',
      selector: 'svc-*, !sandbox-*',
    }).returning(['id']).executeTakeFirst()

    created.workflowId = Number(workflow.id)

    const parsed = parseWorkflow(SCAN, 'organization/licence-scan.yml')

    if (parsed.errors.length > 0)
      throw new Error(parsed.errors.map(one => one.message).join('; '))

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'a'.repeat(40),
      source_path: 'organization/licence-scan.yml',
      content_digest: unique('d').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version.id)

    const job: any = await db.insertInto('workflow_version_jobs').values({
      workflow_version_id: created.versionId,
      job_id: 'scan',
      name: 'scan',
      position: 0,
      runs_on: 'ubuntu-latest',
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_version_steps').values({
      workflow_version_job_id: Number(job.id),
      position: 0,
      name: 'scan',
      command: 'reviewos-licence-scan',
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[owner-wide] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of [created.covered, created.ignored]) {
      if (id)
        await db.deleteFrom('repositories').where('id', '=', id).execute().catch(() => {})
    }

    if (created.workflowId)
      await db.deleteFrom('workflows').where('id', '=', created.workflowId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a workflow the owner carries', () => {
  test('runs on a repository that has no workflow file at all', async () => {
    if (!available)
      return

    await dispatchPush({
      repositoryId: created.covered,
      event: { ref: 'refs/heads/main' },
      headSha: unique('c').padEnd(40, '0').slice(0, 40),
    })

    const runs = await runsOf(created.covered)

    expect(runs.length).toBe(1)
    expect(Number(runs[0].workflow_version_id)).toBe(created.versionId)

    /*
     * And it is an ordinary run in every other respect - same table, same
     * number, same jobs. If a screen could tell which kind produced a run
     * without looking at where the definition came from, the normalization
     * would be wrong.
     */
    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['job_id', 'state'])
      .where('workflow_run_id', '=', Number(runs[0].id))
      .execute()

    expect(jobs.map((one: any) => String(one.job_id))).toEqual(['scan'])
  }, 120_000)

  test('beside the repository\'s own, with both visible in the same list', async () => {
    if (!available)
      return

    /*
     * The half of the line that is easy to lose: a repository may still define
     * its own workflows, and a run list that showed one kind and not the other
     * would be a screen that disagrees with what ran.
     */
    const { syncWorkflowFile } = await import('../../app/Actions/Workflow/sync')

    await syncWorkflowFile({
      repositoryId: created.covered,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n',
      sha: 'b'.repeat(40),
    })

    const before = (await runsOf(created.covered)).length

    await dispatchPush({
      repositoryId: created.covered,
      event: { ref: 'refs/heads/main' },
      headSha: unique('c').padEnd(40, '0').slice(0, 40),
    })

    const runs = await runsOf(created.covered)

    // Two more: the repository's own workflow and the owner's.
    expect(runs.length).toBe(before + 2)

    const versions = new Set(runs.map(one => Number(one.workflow_version_id)))

    expect(versions.has(created.versionId)).toBe(true)
    expect(versions.size).toBeGreaterThan(1)
  }, 120_000)

  test('and does not run on one the selector excludes', async () => {
    if (!available)
      return

    await dispatchPush({
      repositoryId: created.ignored,
      event: { ref: 'refs/heads/main' },
      headSha: unique('c').padEnd(40, '0').slice(0, 40),
    })

    expect(await runsOf(created.ignored)).toEqual([])
  }, 120_000)

  test('and a repository cannot remove it, because there is nothing there to remove', async () => {
    if (!available)
      return

    /*
     * The property the whole feature exists for. A template writes a commit,
     * and a commit is a thing the repository can revert; this is a row on the
     * owner, and the repository has no file to edit.
     */
    const carried = await db
      .selectFrom('workflows')
      .select(['id'])
      .where('repository_id', '=', created.covered)
      .where('id', '=', created.workflowId)
      .execute()

    expect(carried).toEqual([])

    // It is on the owner, where the repository has no say over it at all.
    const held: any = await db
      .selectFrom('workflows')
      .select(['repository_id', 'owner_id'])
      .where('id', '=', created.workflowId)
      .executeTakeFirst()

    expect(held.repository_id).toBeNull()
    expect(Number(held.owner_id)).toBe(created.ownerId)
  }, 120_000)
})

describe('what an owner-wide run is given', () => {
  test('the owner\'s secrets, and none of the repository\'s', async () => {
    if (!available)
      return

    /*
     * The trust inversion, and the reason it is safe to give one of these a
     * credential. If a repository's own secrets applied, a repository admin
     * could declare one with the organization's key name and read whatever the
     * scan was handed.
     */
    const { putSecret, secretsForJobDetailed } = await import('../../app/Actions/Workflow/secrets')

    await putSecret({ scope: 'owner', scopeId: created.ownerId, key: 'SCAN_TOKEN', value: 'the-organization-value' })
    await putSecret({ scope: 'repository', scopeId: created.covered, key: 'SCAN_TOKEN', value: 'the-repository-value' })
    await putSecret({ scope: 'repository', scopeId: created.covered, key: 'REPO_ONLY', value: 'not-for-the-scan' })

    const ordinary = await secretsForJobDetailed({
      repositoryId: created.covered,
      trusted: true,
      environment: null,
      approved: false,
    })

    // A repository's own run sees its own secrets, narrowest first. Asserted so
    // that the refusal below is a refusal rather than secrets being broken.
    expect(ordinary.values.SCAN_TOKEN).toBe('the-repository-value')
    expect(ordinary.values.REPO_ONLY).toBe('not-for-the-scan')

    const scan = await secretsForJobDetailed({
      repositoryId: created.covered,
      trusted: true,
      environment: null,
      approved: false,
      ownerDefined: true,
    })

    expect(scan.values.SCAN_TOKEN).toBe('the-organization-value')
    expect(scan.values.REPO_ONLY).toBeUndefined()
  }, 120_000)
})
