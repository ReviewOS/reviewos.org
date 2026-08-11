// Storing a workflow file, against the real tables.
//
// Written as an end to end test rather than over a stubbed database because
// every claim worth making here is about what the rows do: the digest is unique
// per workflow, the graph hangs off a version that is never edited, and
// deleting a repository takes its workflows with it. A stub would agree with
// whatever this file asserted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { digestOf, syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Test
        run: bun test
  lint:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: bun run lint
`

async function sync(source: string, path = '.github/workflows/ci.yml', sha = 'a'.repeat(40)) {
  return syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path,
    source,
    sha,
  })
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('wfs')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Workflow Sync', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the workflow sync end to end test',
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
    console.warn(`[workflow-sync] skipping: ${error instanceof Error ? error.message : String(error)}`)
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
  catch { /* the next run uses fresh names anyway */ }
})

describe('storing a workflow', () => {
  test('writes the workflow, a version, and the graph under it', async () => {
    if (!available)
      return

    const result = await sync(CI)

    expect(result.ok).toBe(true)
    expect(result.createdVersion).toBe(true)

    const jobs: any[] = await db
      .selectFrom('workflow_version_jobs')
      .select(['id', 'job_id', 'position', 'needs', 'runs_on'])
      .where('workflow_version_id', '=', result.versionId)
      .orderBy('position')
      .execute()

    expect(jobs.map(job => job.job_id)).toEqual(['test', 'lint'])
    expect(jobs[1].needs).toBe('test')
    expect(jobs[0].runs_on).toBe('ubuntu-latest')

    const steps: any[] = await db
      .selectFrom('workflow_version_steps')
      .select(['position', 'uses', 'command', 'inputs'])
      .where('workflow_version_job_id', '=', Number(jobs[0].id))
      .orderBy('position')
      .execute()

    expect(steps[0].uses).toBe('actions/checkout@v4')
    expect(steps[0].command).toBeNull()
    expect(JSON.parse(steps[0].inputs)).toEqual({ 'fetch-depth': 0 })
    expect(steps[1].command).toBe('bun test')
  })

  test('records the triggers where dispatch can read them', async () => {
    if (!available)
      return

    const result = await sync(CI)

    const version: any = await db
      .selectFrom('workflow_versions')
      .select(['on_push', 'on_pull_request', 'push_branches', 'push_paths'])
      .where('id', '=', result.versionId)
      .executeTakeFirst()

    expect(version.on_push).toBe(true)
    expect(version.on_pull_request).toBe(false)
    expect(version.push_branches).toBe('main')
    expect(version.push_paths).toBe('src/**')
  })

  /*
   * The property that keeps versions from growing per commit. A repository with
   * a daily push would otherwise accumulate a version a day, all identical, and
   * "which versions of this workflow have existed" stops being answerable.
   */
  test('the same content on a later push reuses the version', async () => {
    if (!available)
      return

    const first = await sync(CI, '.github/workflows/reuse.yml', 'a'.repeat(40))
    const second = await sync(CI, '.github/workflows/reuse.yml', 'b'.repeat(40))

    expect(second.createdVersion).toBe(false)
    expect(second.versionId).toBe(first.versionId)
    expect(second.workflowId).toBe(first.workflowId)
  })

  test('and changed content makes a second version of the same workflow', async () => {
    if (!available)
      return

    const path = '.github/workflows/changing.yml'
    const first = await sync(CI, path)
    const second = await sync(CI.replace('bun test', 'bun test --coverage'), path)

    expect(second.createdVersion).toBe(true)
    expect(second.versionId).not.toBe(first.versionId)
    expect(second.workflowId).toBe(first.workflowId)
  })

  /*
   * Keyed on the path rather than the name: renaming `name:` is an edit to a
   * workflow, and keying on the name would make it a different workflow with
   * none of its history.
   */
  test('renaming the workflow renames the row rather than making a new one', async () => {
    if (!available)
      return

    const path = '.github/workflows/renamed.yml'
    const first = await sync(CI, path)
    const second = await sync(CI.replace('name: CI', 'name: Continuous Integration'), path)

    expect(second.workflowId).toBe(first.workflowId)

    const row: any = await db.selectFrom('workflows').select(['name']).where('id', '=', first.workflowId).executeTakeFirst()
    expect(row.name).toBe('Continuous Integration')
  })
})

describe('a workflow that does not parse', () => {
  test('is refused, and writes nothing', async () => {
    if (!available)
      return

    const before: any = await db.selectFrom('workflow_versions').select(db.fn.countAll().as('n')).executeTakeFirst()

    const result = await sync('on: push\njobs:\n  broken: {}\n', '.github/workflows/broken.yml')

    expect(result.ok).toBe(false)
    expect(result.versionId).toBeNull()
    expect(result.errors.length).toBeGreaterThan(0)

    const after: any = await db.selectFrom('workflow_versions').select(db.fn.countAll().as('n')).executeTakeFirst()
    expect(Number(after.n)).toBe(Number(before.n))
  })
})

describe('digestOf', () => {
  test('is stable, and changes with the bytes', () => {
    expect(digestOf('a')).toBe(digestOf('a'))
    expect(digestOf('a')).not.toBe(digestOf('b'))
    expect(digestOf('a')).toHaveLength(64)
  })

  /*
   * Of the bytes, not of the parsed graph. A comment change is a change
   * somebody made, and a history that silently merged it could not answer what
   * was in the file when a run happened.
   */
  test('a comment is a change', () => {
    expect(digestOf('on: push\n')).not.toBe(digestOf('# why\non: push\n'))
  })
})

describe('deleting the repository', () => {
  test('takes its workflows and their versions with it', async () => {
    if (!available)
      return

    const handle = unique('wfd')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Cascade', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    const name = unique('repo')
    const repository: any = await db.insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: Number(owner.id),
        name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${handle}/${name}.git`,
      })
      .returning(['id']).executeTakeFirst()

    const result = await syncWorkflowFile({
      repositoryId: Number(repository.id),
      ownerType: 'user',
      ownerId: Number(owner.id),
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'c'.repeat(40),
    })

    // The point of the test: this must not fail on a foreign key. A repository
    // that once had a workflow has to remain deletable.
    await db.deleteFrom('repositories').where('id', '=', Number(repository.id)).execute()

    const workflow: any = await db.selectFrom('workflows').select(['id']).where('id', '=', result.workflowId).executeTakeFirst()
    const version: any = await db.selectFrom('workflow_versions').select(['id']).where('id', '=', result.versionId).executeTakeFirst()

    expect(workflow).toBeUndefined()
    expect(version).toBeUndefined()

    await db.deleteFrom('users').where('id', '=', Number(owner.id)).execute()
  })
})
