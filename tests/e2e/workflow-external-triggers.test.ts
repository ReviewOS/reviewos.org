// The two triggers that were recognised and inert: `repository_dispatch` and
// `workflow_run`.
//
// Both had been stored on every version since the parser learned to read them,
// and a workflow naming either never ran. That is the failure this phase keeps
// producing, and the shape of it here is worse than usual: a workflow whose
// only trigger is one of these looks registered, looks correct, and is a file
// that will never do anything.
//
// `repository_dispatch` is the trigger for something that happened somewhere
// else. `workflow_run` is the second half of a pipeline that must not be
// editable by whoever wrote the first half.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush, dispatchRepositoryDispatch, dispatchWorkflowRun } from '../../app/Actions/Workflow/dispatch'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function sync(path: string, source: string, sha = 'a'.repeat(40)): Promise<void> {
  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path,
    source,
    sha,
  })
}

/** The runs this repository has, newest last. */
async function runs(): Promise<any[]> {
  return db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select([
      'workflow_runs.id as id',
      'workflow_runs.event as event',
      'workflow_runs.event_ref as event_ref',
      'workflow_runs.trusted as trusted',
      'workflow_runs.dispatch_inputs as dispatch_inputs',
      'workflows.name as workflow',
    ])
    .where('workflow_runs.repository_id', '=', created.repositoryId)
    .orderBy('workflow_runs.id')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('ext')

    const owner: any = await db.insertInto('users')
      .values({ name: 'External', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
    console.warn(`[external-triggers] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('repository_dispatch', () => {
  test('starts a run for the event type it names, and carries the payload', async () => {
    if (!available)
      return

    await sync('.github/workflows/deployed.yml', `name: Deployed
on:
  repository_dispatch:
    types: [deploy-finished]
jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - run: ./announce
`)

    const outcome = await dispatchRepositoryDispatch({
      repositoryId: created.repositoryId,
      eventType: 'deploy-finished',
      clientPayload: { environment: 'production', version: '4.2.0' },
    })

    expect(outcome.created).toHaveLength(1)

    const row = (await runs()).find(one => Number(one.id) === Number(outcome.created[0]))

    expect(String(row.event)).toBe('repository_dispatch')

    /*
     * The payload, verbatim. The whole point of this trigger is that the caller
     * knows something the instance does not, and a payload that arrived as an
     * empty object would make the run pointless while looking like it worked.
     */
    const stored = JSON.parse(String(row.dispatch_inputs ?? '{}'))

    expect(stored.client_payload.environment).toBe('production')
    expect(stored.event_type).toBe('deploy-finished')

    // Trusted: the caller supplied a name and a payload, not code, and the
    // definition is the registered one on the default branch.
    expect(row.trusted === true || row.trusted === 1).toBe(true)
  }, 120_000)

  test('and starts nothing for a type no workflow watches', async () => {
    if (!available)
      return

    const outcome = await dispatchRepositoryDispatch({
      repositoryId: created.repositoryId,
      eventType: 'something-else',
    })

    // Not an error - a program calling this does not know what the repository
    // watches for - but nothing runs, and the endpoint says so in words.
    expect(outcome.created).toHaveLength(0)
  }, 120_000)

  test('a workflow naming no types takes every event type, which is Actions\' rule', async () => {
    if (!available)
      return

    await sync('.github/workflows/anything.yml', `name: Anything
on: repository_dispatch
jobs:
  note:
    runs-on: ubuntu-latest
    steps:
      - run: ./note
`)

    const outcome = await dispatchRepositoryDispatch({
      repositoryId: created.repositoryId,
      eventType: 'whatever-it-is',
    })

    expect(outcome.created).toHaveLength(1)
  }, 120_000)

  test('two calls are two runs, because a caller retrying did not hear the first answer', async () => {
    if (!available)
      return

    const first = await dispatchRepositoryDispatch({ repositoryId: created.repositoryId, eventType: 'deploy-finished' })
    const second = await dispatchRepositoryDispatch({ repositoryId: created.repositoryId, eventType: 'deploy-finished' })

    /*
     * The redelivery index is on (version, ref, head, event) and every one of
     * these shares a head commit, so without the event type and the clock in
     * the ref the second call would look like the first one redelivered.
     */
    expect(first.created.length).toBeGreaterThan(0)
    expect(second.created.length).toBe(first.created.length)
    expect(first.created.some(id => second.created.includes(id))).toBe(false)
  }, 120_000)
})

describe('workflow_run', () => {
  test('starts the workflow that waits for another one to finish', async () => {
    if (!available)
      return

    await sync('.github/workflows/build.yml', `name: Build
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`)

    await sync('.github/workflows/publish.yml', `name: Publish
on:
  workflow_run:
    workflows: [Build]
    types: [completed]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: ./publish
`)

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b1'.repeat(20),
    })

    const buildRun = (await runs()).find(one => Number(one.id) === Number(dispatched.created[0]) && String(one.workflow) === 'Build')
      ?? (await runs()).find(one => String(one.workflow) === 'Build')

    expect(buildRun).toBeTruthy()

    // The build finishes, which is the only thing that starts the second one.
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', Number(buildRun.id))
      .execute()

    await settleRun(Number(buildRun.id))

    const after = await runs()
    const published = after.filter(one => String(one.event) === 'workflow_run')

    expect(published).toHaveLength(1)
    expect(String(published[0].workflow)).toBe('Publish')

    /*
     * And it knows what started it. `github.event.workflow_run` is how the
     * second workflow finds the first one's artifacts, and a run that could not
     * name its trigger would be one that has to guess.
     */
    const stored = JSON.parse(String(published[0].dispatch_inputs ?? '{}'))

    expect(String(stored.workflow_run.name)).toBe('Build')
    expect(Number(stored.workflow_run.id)).toBe(Number(buildRun.id))
  }, 120_000)

  test('does not start from a run that was itself started that way', async () => {
    if (!available)
      return

    const started = (await runs()).filter(one => String(one.event) === 'workflow_run')

    expect(started.length).toBeGreaterThan(0)

    const outcome = await dispatchWorkflowRun({ runId: Number(started[0].id) })

    /*
     * Actions bounds the same loop with a depth limit; refusing outright is
     * simpler to explain, and there is no honest use for the second hop that
     * `needs:` does not already cover.
     */
    expect(outcome.created).toHaveLength(0)
  }, 120_000)

  test('and refuses a `workflow_run` that names no workflows rather than firing on all of them', async () => {
    if (!available)
      return

    await sync('.github/workflows/greedy.yml', `name: Greedy
on:
  workflow_run:
    types: [completed]
jobs:
  everything:
    runs-on: ubuntu-latest
    steps:
      - run: ./everything
`)

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'c1'.repeat(20),
    })

    const buildRun = (await runs()).filter(one => String(one.workflow) === 'Build').pop()

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'succeeded', finished_at: new Date().toISOString() } as any)
      .where('workflow_run_id', '=', Number(buildRun.id))
      .execute()

    const before = (await runs()).filter(one => String(one.workflow) === 'Greedy').length

    await settleRun(Number(buildRun.id))

    const after = (await runs()).filter(one => String(one.workflow) === 'Greedy').length

    /*
     * A workflow that started after *every* workflow in the repository would
     * start after itself, and the first thing anybody would notice is a loop.
     * Actions requires `workflows:`; so does this.
     */
    expect(after).toBe(before)
    expect(dispatched.created.length).toBeGreaterThan(0)
  }, 120_000)
})
