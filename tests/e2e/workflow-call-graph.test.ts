// A workflow call inside the caller's graph: what waits for it, and what it
// hands back.
//
// The defect this file was written for: a call job had **no row of its own**.
// Its jobs were copied into the run under a prefix, and `needs: [call]` in the
// caller named a job that was not there - so the graph read it as missing, the
// settler swept the dependent as unreachable, and the run went green having
// skipped the job after the call. A deploy behind a called build is exactly that
// shape, and nothing about the run said so.
//
// The call is a barrier now, which also gives the called workflow's declared
// outputs somewhere to live: `on.workflow_call.outputs` is the one place the
// `jobs` context exists, and the caller reads the result as
// `needs.<call>.outputs.<name>`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { jobsContext } from '../../app/Actions/Workflow/callOutputs'
import { settleRun } from '../../app/Actions/Workflow/settle'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const REUSABLE = `name: Reusable
on:
  workflow_call:
    outputs:
      version:
        description: what was built
        value: \${{ jobs.compute.outputs.version }}
jobs:
  compute:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: ./compute
`

const CALLER = `name: Caller
on: push
jobs:
  first:
    runs-on: ubuntu-latest
    steps:
      - run: ./first
  call:
    needs: [first]
    uses: ./.github/workflows/reusable.yml
  after:
    needs: [call]
    runs-on: ubuntu-latest
    steps:
      - run: ./after
`

async function sync(path: string, source: string, sha: string): Promise<void> {
  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path,
    source,
    sha,
  })
}

async function jobsOf(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'kind', 'needs', 'outputs'])
    .where('workflow_run_id', '=', runId)
    .orderBy('position')
    .execute()
}

/** Finish whatever is queued, the way a runner reporting would, then settle. */
async function tick(runId: number, outputs: Record<string, string> | null = null): Promise<void> {
  await db
    .updateTable('workflow_jobs')
    .set({
      state: 'succeeded',
      finished_at: new Date().toISOString(),
      ...(outputs ? { outputs: JSON.stringify(outputs) } : {}),
    } as any)
    .where('workflow_run_id', '=', runId)
    .where('state', '=', 'queued')
    .execute()

  await settleRun(runId)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('cal')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Caller', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    await sync('.github/workflows/reusable.yml', REUSABLE, 'a'.repeat(40))
    await sync('.github/workflows/caller.yml', CALLER, 'a'.repeat(40))

    available = true
  }
  catch (error) {
    console.warn(`[call-graph] skipping: ${error instanceof Error ? error.message : String(error)}`)
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

describe('the `jobs` context', () => {
  test('is the called workflow\'s own view of itself, without the caller\'s prefix', () => {
    const context = jobsContext([
      { job_id: 'deploy/build', state: 'succeeded', outputs: JSON.stringify({ version: '1.2.3' }) },
      { job_id: 'deploy/build/inner', state: 'succeeded', outputs: JSON.stringify({ version: 'nested' }) },
      { job_id: 'unrelated', state: 'failed', outputs: null },
    ], 'deploy')

    /*
     * A called workflow cannot know it was called `deploy`, so an expression
     * written against `jobs.build` has to keep working when it is - and a
     * workflow it called in turn belongs to *that* workflow's context, not this
     * one's.
     */
    expect(Object.keys(context)).toEqual(['build'])
    expect(context.build.outputs.version).toBe('1.2.3')
    expect(context.build.result).toBe('succeeded')
  })
})

describe('a job that needs a call', () => {
  test('waits for it, runs after it, and reads what it handed back', async () => {
    if (!available)
      return

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b1'.repeat(20),
    })

    const runId = Number(dispatched.created.find(Boolean))
    const first = await jobsOf(runId)

    // The call has a row of its own, as a barrier: it is finished when its jobs
    // are, and it never reaches a machine.
    const call = first.find(one => String(one.job_id) === 'call')

    expect(call).toBeTruthy()
    expect(String(call.kind)).toBe('wait')
    expect(String(call.needs)).toContain('call/compute')

    /*
     * And the called workflow waits for what the *call* waits for. Without
     * grafting the call's `needs:` onto the called workflow's root jobs, a
     * called workflow starts immediately however much the caller said it should
     * wait.
     */
    const compute = first.find(one => String(one.job_id) === 'call/compute')

    expect(String(compute.state)).toBe('blocked')
    expect(String(compute.needs)).toBe('first')

    // `first` runs, which releases the called workflow.
    await tick(runId)

    const second = await jobsOf(runId)

    expect(String(second.find(one => String(one.job_id) === 'call/compute').state)).toBe('queued')

    // The called job finishes with an output, which releases the barrier.
    await tick(runId, { version: '1.2.3' })

    const third = await jobsOf(runId)
    const barrier = third.find(one => String(one.job_id) === 'call')

    expect(String(barrier.state)).toBe('succeeded')

    /*
     * The called workflow's declared output, resolved through the `jobs`
     * context and stored where the caller reads any other job's outputs.
     */
    expect(JSON.parse(String(barrier.outputs ?? '{}')).version).toBe('1.2.3')

    /*
     * And the job after the call is queued rather than skipped. This is the
     * assertion the whole file exists for: it was `skipped`, the run was
     * `succeeded`, and a deploy behind a called build had silently not
     * happened.
     */
    expect(String(third.find(one => String(one.job_id) === 'after').state)).toBe('queued')

    await tick(runId)

    const run: any = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()

    expect(String(run.state)).toBe('succeeded')
  }, 120_000)

  test('and a call that cannot be resolved skips what came after it, with the reason on the call', async () => {
    if (!available)
      return

    await sync('.github/workflows/broken.yml', `name: Broken
on: push
jobs:
  call:
    uses: ./.github/workflows/not-here.yml
  after:
    needs: [call]
    runs-on: ubuntu-latest
    steps:
      - run: ./after
`, 'c1'.repeat(20))

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'c1'.repeat(20),
    })

    for (const runId of dispatched.created) {
      const rows = await jobsOf(Number(runId))
      const call = rows.find(one => String(one.job_id) === 'call' && String(one.state) === 'skipped')

      if (!call)
        continue

      await settleRun(Number(runId))

      const after = (await jobsOf(Number(runId))).find(one => String(one.job_id) === 'after')

      /*
       * Skipped rather than left blocked forever, and the reason is on the call
       * row: a run that silently misses half its pipeline is the failure people
       * spend an afternoon on.
       */
      expect(String(after.state)).toBe('skipped')

      return
    }

    throw new Error('the broken caller did not produce a skipped call row')
  }, 120_000)
})

describe('the `strategy` context', () => {
  test('says which of a matrix\'s jobs this one is, and what the policy was', async () => {
    if (!available)
      return

    const { hashToken } = await import('../../app/Actions/Runner/authenticate')
    const { route } = await import('@stacksjs/router')

    await sync('.github/workflows/matrix.yml', `name: Matrixed
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [18, 20, 22]
    steps:
      - run: ./test \${{ matrix.node }}
`, 'd1'.repeat(20))

    const token = `tok-${unique('s')}`

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(token),
      labels: 'ubuntu-latest',
      state: 'active',
    } as any).returning(['id']).executeTakeFirst()

    await route.importRoutes()
    const server: any = await route.serve({ port: 0, hostname: '127.0.0.1' })
    const port = Number(server?.port ?? 0)

    try {
      // Everything older out of the way, so the claim below is one of these.
      await db
        .updateTable('workflow_jobs')
        .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
        .where('state', 'in', ['blocked', 'queued', 'running'])
        .execute()

      await dispatchPush({
        repositoryId: created.repositoryId,
        event: { ref: 'refs/heads/main' },
        headSha: 'd1'.repeat(20),
      })

      const seen: number[] = []

      for (let claim = 0; claim < 3; claim++) {
        const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Runner-Protocol': '1' },
          body: '{}',
        })

        const body: any = await answer.json()

        if (!body.job)
          break

        if (String(body.job.key) !== 'test') {
          // Somebody else's leftover work. Put it back out of the way and poll
          // again rather than asserting about a job this test did not create.
          await db
            .updateTable('workflow_jobs')
            .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
            .where('id', '=', Number(body.job.id))
            .execute()

          claim -= 1
          continue
        }

        /*
         * `fail-fast` and `max-parallel` were copied onto the run and read by
         * the graph and by nothing a workflow could see, which is this phase's
         * recurring shape: a value stored and never readable.
         */
        expect(body.job.strategy.fail_fast).toBe(false)
        expect(Number(body.job.strategy.max_parallel)).toBe(2)
        expect(Number(body.job.strategy.job_total)).toBe(3)

        seen.push(Number(body.job.strategy.job_index))

        // Claimed jobs have to stop being claimable, or the next poll takes the
        // same one and the indexes below prove nothing.
        await db
          .updateTable('workflow_jobs')
          .set({ state: 'running' } as any)
          .where('id', '=', Number(body.job.id))
          .execute()
      }

      // Numbered from zero, one per combination, and distinct - a workflow that
      // shards by `strategy.job-index` breaks quietly if any of those is wrong.
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every(index => index >= 0 && index < 3)).toBe(true)
      expect(new Set(seen).size).toBe(seen.length)
    }
    finally {
      server?.stop?.(true)
      await db.deleteFrom('runners').where('id', '=', Number(runner.id)).execute().catch(() => {})
    }
  }, 120_000)
})
