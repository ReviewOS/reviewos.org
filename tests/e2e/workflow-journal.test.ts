// Durable execution, against the real table.
//
// The claim being tested is the one the whole design exists for: kill the thing
// running a workflow at any instant, start it again, and no completed step runs
// twice. Everything else here - divergence, budgets, two orchestrators racing -
// is a way that claim gets quietly broken, which is why each one has a test
// rather than a paragraph.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, workflowId: 0, versionId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A run of its own, so one test's journal is never another's. */
async function aRun(): Promise<number> {
  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.repositoryId,
    number: Math.floor(Math.random() * 1_000_000),
    state: 'running',
    event: 'push',
    event_ref: 'refs/heads/main',
    head_sha: 'e'.repeat(40),
    definition_sha: 'e'.repeat(40),
    trusted: true,
  }).returning(['id']).executeTakeFirst()

  return Number(run.id)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('workflow_journal_entries').select(['id']).limit(1).execute()

    created.handle = unique('jrn')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Journal', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.reviewos/workflows/durable.ts',
      name: 'Durable',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.workflowId = Number(workflow.id)

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: created.workflowId,
      source_sha: 'e'.repeat(40),
      source_path: '.reviewos/workflows/durable.ts',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    created.versionId = Number(version.id)
    available = true
  }
  catch (error) {
    console.warn(`[journal] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  if (!available || !db)
    return

  await db.deleteFrom('workflows').where('id', '=', created.workflowId).execute().catch(() => null)
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => null)
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => null)
})

/**
 * A workflow program, as far as this test is concerned.
 *
 * It counts what it actually executed. Running it twice against one journal and
 * finding the counter unchanged the second time *is* durable execution - there
 * is no better proof, and a test that asserted on the rows instead would pass
 * for a journal that records perfectly and replays nothing.
 */
async function runProgram(runId: number, steps: string[], executed: string[]): Promise<{ results: unknown[], stopped?: string }> {
  const { record, resolve } = await import('../../app/Actions/Workflow/journal')

  const results: unknown[] = []

  for (const [index, name] of steps.entries()) {
    const verdict = await record({
      runId,
      repositoryId: created.repositoryId,
      sequence: index + 1,
      kind: 'step',
      name,
      args: { name },
    })

    if (verdict.decision === 'replay') {
      results.push(verdict.result)
      continue
    }

    if (verdict.decision === 'diverged' || verdict.decision === 'refused')
      return { results, stopped: verdict.reason }

    if (verdict.decision !== 'dispatch')
      return { results, stopped: `unexpected: ${verdict.decision}` }

    // The work. Recorded as having happened, which is the thing a replay must
    // not do again.
    executed.push(name)
    const value = `${name}-was-run`

    await resolve(verdict.entryId, { result: value, durationMs: 1 })
    results.push(value)
  }

  return { results }
}

describe('a program that was killed halfway', () => {
  test('does not repeat a single completed step when it starts again', async () => {
    if (!available)
      return

    const runId = await aRun()
    const executed: string[] = []

    // The first attempt gets three steps in before its machine dies.
    await runProgram(runId, ['checkout', 'install', 'test'], executed)

    expect(executed).toEqual(['checkout', 'install', 'test'])

    /*
     * The restart. The program runs from its first line again - that is the
     * whole model - and the journal answers the first three calls without
     * doing anything.
     */
    const second = await runProgram(runId, ['checkout', 'install', 'test', 'deploy'], executed)

    expect(executed).toEqual(['checkout', 'install', 'test', 'deploy'])
    // And the replayed calls returned what they returned the first time, so a
    // later step reading an earlier one's output reads the same value.
    expect(second.results).toEqual(['checkout-was-run', 'install-was-run', 'test-was-run', 'deploy-was-run'])
  }, 120_000)
})

describe('a program that is not the program that produced the journal', () => {
  /**
   * The failure mode of every durable execution system, and the reason this is
   * loud. A replay that quietly took the wrong branch would hand step 4's
   * recorded result to a call that is now step 4 of something else - and
   * nothing anywhere would say so.
   */
  test('fails loudly and names the call that changed', async () => {
    if (!available)
      return

    const runId = await aRun()
    const executed: string[] = []

    await runProgram(runId, ['checkout', 'install'], executed)

    // Somebody edited the workflow, or it reads the clock and took another
    // branch. Either way call 2 is a different call now.
    const second = await runProgram(runId, ['checkout', 'deploy'], executed)

    expect(second.stopped).toBeTruthy()
    // Named rather than reported: "call 2 was step(install) and is now
    // step(deploy)" sends somebody to the line, where "non-deterministic
    // workflow" sends them to read the whole file.
    expect(second.stopped).toContain('call 2')
    expect(second.stopped).toContain('install')
    expect(second.stopped).toContain('deploy')

    // And nothing ran a second time on the way to finding out.
    expect(executed).toEqual(['checkout', 'install'])
  }, 120_000)
})

describe('two orchestrators for one run', () => {
  /**
   * Happens whenever a lease lapses while the first machine is still alive: the
   * scheduler hands the work to a second one and there are briefly two. The
   * unique index picks a winner, and the loser finds itself replaying rather
   * than dispatching - so the step runs once, not twice.
   */
  test('one dispatches and the other replays, rather than both running the step', async () => {
    if (!available)
      return

    const { record, resolve } = await import('../../app/Actions/Workflow/journal')

    const runId = await aRun()
    const call = { runId, repositoryId: created.repositoryId, sequence: 1, kind: 'step', name: 'deploy', args: {} }

    const both = await Promise.all([record(call), record(call)])
    const dispatches = both.filter(one => one.decision === 'dispatch')

    expect(dispatches).toHaveLength(1)
    // The loser is told to wait rather than told it failed: the work is being
    // done, just not by it.
    expect(both.filter(one => one.decision === 'wait')).toHaveLength(1)

    await resolve((dispatches[0] as any).entryId, { result: 'deployed' })

    // And once the winner finishes, the loser's next look is a replay.
    const after = await record(call)

    expect(after.decision).toBe('replay')
    expect((after as any).result).toBe('deployed')

    const rows = await db
      .selectFrom('workflow_journal_entries')
      .select(['id'])
      .where('workflow_run_id', '=', runId)
      .execute()

    expect(rows).toHaveLength(1)
  }, 120_000)
})

describe('a runaway workflow', () => {
  test('is stopped by its step budget, with the number in the reason', async () => {
    if (!available)
      return

    const { record } = await import('../../app/Actions/Workflow/journal')

    const runId = await aRun()
    const budgets = { maxSteps: 3, maxJournalBytes: 8 * 1024 * 1024, maxWallMs: 60_000 }

    for (let index = 1; index <= 3; index += 1) {
      const verdict = await record({ runId, sequence: index, kind: 'step', name: `step-${index}`, args: {} }, budgets)

      expect(verdict.decision).toBe('dispatch')
    }

    const refused = await record({ runId, sequence: 4, kind: 'step', name: 'step-4', args: {} }, budgets)

    expect(refused.decision).toBe('refused')
    // A run killed with no reason is a run somebody reruns unchanged.
    expect((refused as any).reason).toContain('3')
  }, 120_000)

  test('and by its journal size, which says what to do instead', async () => {
    if (!available)
      return

    const { record, resolve } = await import('../../app/Actions/Workflow/journal')

    const runId = await aRun()
    const budgets = { maxSteps: 100, maxJournalBytes: 200, maxWallMs: 60_000 }

    const first = await record({ runId, sequence: 1, kind: 'step', name: 'big', args: {} }, budgets)

    await resolve((first as any).entryId, { result: 'x'.repeat(300) })

    const refused = await record({ runId, sequence: 2, kind: 'step', name: 'next', args: {} }, budgets)

    expect(refused.decision).toBe('refused')
    // Told where the value belongs, rather than only that it does not belong
    // here.
    expect((refused as any).reason).toContain('artifacts')
  }, 120_000)
})

describe('a call that failed', () => {
  test('is replayed as a failure rather than quietly run again', async () => {
    if (!available)
      return

    /*
     * A step that failed is a decision the run already made. Re-running it on
     * restart would turn a failed deploy into two attempted deploys, which is
     * the same class of problem durability exists to prevent.
     */
    const { record, resolve } = await import('../../app/Actions/Workflow/journal')

    const runId = await aRun()
    const call = { runId, sequence: 1, kind: 'step', name: 'flaky', args: {} }

    const first = await record(call)
    await resolve((first as any).entryId, { error: 'the step exited 1' })

    const replayed = await record(call)

    expect(replayed.decision).toBe('failed')
    expect((replayed as any).error).toBe('the step exited 1')
  }, 120_000)
})

describe('a sleep', () => {
  test('parks the call and says when it may be resumed, so the runner can go', async () => {
    if (!available)
      return

    // A workflow waiting three days for an approval must not hold a lease for
    // three days.
    const { record, suspend } = await import('../../app/Actions/Workflow/journal')

    const runId = await aRun()
    const call = { runId, sequence: 1, kind: 'sleep', name: '3d', args: { ms: 259_200_000 } }

    const first = await record(call)
    const wakeAt = new Date(Date.now() + 259_200_000)

    await suspend((first as any).entryId, wakeAt)

    const seen = await record(call)

    expect(seen.decision).toBe('wait')
    expect(Date.parse(String((seen as any).wakeAt))).toBe(wakeAt.getTime())
  }, 120_000)
})
