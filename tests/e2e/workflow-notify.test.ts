// `notify:` on a job: telling one person that one job finished.
//
// Distinct from workflow-level notification, which is the repository's webhooks
// and its watchers' subscriptions. The case this covers is the one those cannot:
// a nightly run with forty green jobs and one red deploy is a notification
// nobody reads unless it names the job.
//
// Two rules carry the feature and both are refusals. It notifies **people on
// this instance**, never an address - a workflow file is editable by anybody who
// can push, and a `notify:` that took an email address would make every
// repository here a mail relay. And a reader who cannot see the repository is
// not told anything, because a notification is not a way to learn that a
// private repository exists.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  watcherId: 0,
  strangerId: 0,
  repositoryId: 0,
  handle: '',
  watcher: '',
  stranger: '',
  name: '',
}

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Sync a workflow that notifies the given entries, and dispatch it. */
async function runWith(notify: string, sha: string): Promise<number> {
  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path: '.github/workflows/nightly.yml',
    source: `name: Nightly
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      notify:
${notify}
    steps:
      - run: ./deploy ${sha.slice(0, 6)}
`,
    sha,
  })

  const dispatched = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: sha,
  })

  return Number(dispatched.created[0])
}

/** Finish every job in a run with the given state, and settle it. */
async function finish(runId: number, state: string): Promise<void> {
  await db
    .updateTable('workflow_jobs')
    .set({ state, finished_at: new Date().toISOString() } as any)
    .where('workflow_run_id', '=', runId)
    .execute()

  await settleRun(runId)
}

async function inboxOf(userId: number): Promise<any[]> {
  return db
    .selectFrom('notifications')
    .select(['id', 'type', 'data'])
    .where('user_id', '=', userId)
    .orderBy('id')
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db.insertInto('users')
        .values({ name: 'Notify', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      return { id: Number(row?.id), handle }
    }

    const owner = await make('nto')
    const watcher = await make('ntw')
    const stranger = await make('nts')

    created.ownerId = owner.id
    created.handle = owner.handle
    created.watcherId = watcher.id
    created.watcher = watcher.handle
    created.strangerId = stranger.id
    created.stranger = stranger.handle
    created.name = unique('repo')

    /*
     * Private, so the access rule is exercised rather than assumed: the watcher
     * is a collaborator and the stranger is not.
     */
    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'private',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    await db.insertInto('repo_collaborators').values({
      repository_id: created.repositoryId,
      user_id: created.watcherId,
      permission: 'write',
    } as any).execute()

    available = true
  }
  catch (error) {
    console.warn(`[notify] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of [created.ownerId, created.watcherId, created.strangerId])
      if (id)
        await db.deleteFrom('notifications').where('user_id', '=', id).execute().catch(() => {})

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    for (const id of [created.ownerId, created.watcherId, created.strangerId])
      if (id)
        await db.deleteFrom('users').where('id', '=', id).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('the key itself', () => {
  test('refuses an email address, and says why', async () => {
    const parsed = parseWorkflow(`name: CI
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      notify:
        - user: somebody@example.com
    steps:
      - run: ./deploy
`, '.github/workflows/ci.yml')

    const message = parsed.errors.map(error => `${error.message} ${error.fix}`).join(' ')

    /*
     * The rule worth being loud about: naming a person means their own
     * preferences decide the channel, and it is what stops a workflow file from
     * turning this instance into a mail relay.
     */
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(message).toContain('handle')
    expect(message).toContain('email address')
  })

  test('refuses a condition that is not one of the three', async () => {
    const parsed = parseWorkflow(`name: CI
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      notify:
        - user: someone
          if: maybe
    steps:
      - run: ./deploy
`, '.github/workflows/ci.yml')

    expect(parsed.errors.map(error => error.message).join(' ')).toContain('notify.if')
  })

  test('takes a bare handle, because that is what people write first', async () => {
    const parsed = parseWorkflow(`name: CI
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      notify: [someone]
    steps:
      - run: ./deploy
`, '.github/workflows/ci.yml')

    expect(parsed.errors).toEqual([])
    expect(parsed.workflow?.jobs[0]?.settings.notify).toEqual([{ user: 'someone', condition: 'always' }])
  })
})

describe('a finished job', () => {
  test('tells the person it named, once', async () => {
    if (!available)
      return

    const runId = await runWith(`        - user: ${created.watcher}`, 'a1'.repeat(20))

    await finish(runId, 'succeeded')

    const inbox = await inboxOf(created.watcherId)

    expect(inbox).toHaveLength(1)
    expect(String(inbox[0].type)).toBe('workflow_job')

    const data = JSON.parse(String(inbox[0].data))

    // The job's name, because the whole point is that one job in a long
    // pipeline is the one somebody cares about.
    expect(String(data.title)).toContain('deploy')
    expect(String(data.title)).toContain('succeeded')
    expect(String(data.url)).toContain('/run/')

    /*
     * And settling again delivers nothing more. The settler runs on every
     * report, so a job that notified once per pass would be the feature people
     * turn off within a day.
     */
    await settleRun(runId)
    await settleRun(runId)

    expect(await inboxOf(created.watcherId)).toHaveLength(1)
  }, 120_000)

  test('honours `if: failure`, which is the entry people actually want', async () => {
    if (!available)
      return

    const green = await runWith(`        - user: ${created.watcher}
          if: failure`, 'b1'.repeat(20))

    await finish(green, 'succeeded')

    const afterGreen = await inboxOf(created.watcherId)

    const red = await runWith(`        - user: ${created.watcher}
          if: failure`, 'c1'.repeat(20))

    await finish(red, 'failed')

    const afterRed = await inboxOf(created.watcherId)

    expect(afterRed.length).toBe(afterGreen.length + 1)
    expect(String(JSON.parse(String(afterRed[afterRed.length - 1].data)).title)).toContain('failed')
  }, 120_000)

  test('counts a cancelled job as a failure, because the deploy did not happen either', async () => {
    if (!available)
      return

    const before = (await inboxOf(created.watcherId)).length

    const runId = await runWith(`        - user: ${created.watcher}
          if: failure`, 'd1'.repeat(20))

    await finish(runId, 'cancelled')

    expect((await inboxOf(created.watcherId)).length).toBe(before + 1)
  }, 120_000)

  test('tells nobody who cannot see the repository', async () => {
    if (!available)
      return

    const runId = await runWith(`        - user: ${created.stranger}`, 'e1'.repeat(20))

    await finish(runId, 'succeeded')

    /*
     * A notification is not a way to learn that a private repository exists,
     * and a workflow author naming a handle is not the person who decides who
     * may read the repository.
     */
    expect(await inboxOf(created.strangerId)).toHaveLength(0)
  }, 120_000)

  test('and nothing at all from a fork\'s run', async () => {
    if (!available)
      return

    const before = (await inboxOf(created.watcherId)).length
    const runId = await runWith(`        - user: ${created.watcher}`, 'f1'.repeat(20))

    /*
     * The workflow comes from the base branch, but the run is somebody else's
     * code - and a stranger who can open a pull request should not be able to
     * make this instance message a maintainer on demand.
     */
    await db.updateTable('workflow_runs').set({ trusted: false } as any).where('id', '=', runId).execute()

    await finish(runId, 'failed')

    expect((await inboxOf(created.watcherId)).length).toBe(before)
  }, 120_000)
})
