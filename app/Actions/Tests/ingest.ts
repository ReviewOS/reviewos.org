/**
 * Test results, from any CI.
 *
 * The shape worth copying from Buildkite's test product: it ingests results
 * from wherever they were produced, so a team gets flake detection *before*
 * they move a single pipeline. A feature that only works once you have migrated
 * is one nobody evaluates.
 *
 * Two formats. **JUnit XML** because every framework in every language can emit
 * it and most already do, and **JSON** because JUnit XML cannot carry the
 * things that turn out to matter - retries, tags, which job it ran in - without
 * somebody inventing an attribute.
 *
 * ## What muting does, exactly
 *
 * A muted test still runs and still reports. Its failures are counted, shown,
 * and kept in its history; they are simply not counted *against the run*. That
 * is the difference from skipping, which most tools conflate with muting: a
 * skipped test teaches nobody anything, so the day it would have started
 * passing again goes unnoticed.
 *
 * What this cannot do is stop the test runner exiting non-zero - that program
 * is not ours and the results arrive after it has finished. The endpoint
 * answers with a verdict that ignores muted failures, so a collector that wants
 * the mute to decide the job's outcome can use it; the documentation says so
 * rather than implying the mute reaches back in time.
 */

import { db } from '@stacksjs/database'
import { notifyProgramsOnly } from '../../Notifications/emit'

export interface IngestInput {
  repositoryId: number
  /** The suite's slug: `unit`, `browser`. Created on first sight. */
  suite: string
  headSha: string
  branch?: string | null
  pullRequestId?: number | null
  workflowRunId?: number | null
  /** The reporter's own id for this run, so a retry is not a second run. */
  key?: string | null
  source: 'junit' | 'json'
  executions: IngestExecution[]
}

export interface IngestExecution {
  scope: string
  name: string
  result: 'passed' | 'failed' | 'skipped'
  durationMs?: number
  retries?: number
  failureMessage?: string | null
  failureStack?: string | null
  workflowJobId?: number | null
  tags?: string[]
}

export interface IngestOutcome {
  ok: boolean
  reason: string
  runId?: number
  /** Whether this was a repeat of a run already recorded. */
  duplicate?: boolean
  /**
   * The verdict *this instance* reaches, which ignores muted failures.
   *
   * Answered so a collector can use it as the job's outcome. The test runner
   * has already exited by the time these results arrive, so nothing here can
   * change what it did.
   */
  verdict?: 'passed' | 'failed'
  counts?: { passed: number, failed: number, skipped: number, mutedFailures: number }
  /** Tests this run showed to be flaky, newly. */
  newlyFlaky?: string[]
}

/**
 * How far back flake detection looks.
 *
 * Twenty executions is a few days of a busy repository and a month of a quiet
 * one, which is the right shape: a test that changed its mind once last spring
 * is not flaky now, and one that did so twice this week is.
 */
export const FLAKE_WINDOW = 20

export async function ingestTestRun(input: IngestInput): Promise<IngestOutcome> {
  if (!input.headSha)
    return { ok: false, reason: 'a test run needs the commit it ran against' }

  if (input.executions.length === 0)
    return { ok: false, reason: 'this report contains no test results' }

  const suite = await suiteFor(input.repositoryId, input.suite)
  // The slug the suite was stored under, which is what the read API takes and
  // what a webhook receiver needs to ask about this run.
  const suiteSlug = slugOfSuite(input.suite)

  /*
   * The same run reported twice is answered as success rather than refused.
   *
   * Every collector retries, and a retry that fails is a collector that retries
   * again. What must not happen is the history doubling, so the key is unique
   * and a repeat returns the run that already exists.
   */
  if (input.key) {
    const existing = await db
      .selectFrom('test_runs')
      .select(['id', 'passed', 'failed', 'skipped', 'muted_failures'])
      .where('test_suite_id', '=', suite)
      .where('external_key', '=', input.key)
      .executeTakeFirst()

    if (existing) {
      return {
        ok: true,
        reason: 'this run was already recorded',
        runId: Number(existing.id),
        duplicate: true,
        verdict: Number(existing.failed) > 0 ? 'failed' : 'passed',
        counts: {
          passed: Number(existing.passed),
          failed: Number(existing.failed),
          skipped: Number(existing.skipped),
          mutedFailures: Number(existing.muted_failures),
        },
      }
    }
  }

  const counts = { passed: 0, failed: 0, skipped: 0, mutedFailures: 0 }
  let duration = 0

  const run = await db
    .insertInto('test_runs')
    .values({
      test_suite_id: suite,
      head_sha: input.headSha,
      branch: input.branch ?? null,
      pull_request_id: input.pullRequestId ?? null,
      workflow_run_id: input.workflowRunId ?? null,
      external_key: input.key ?? null,
      source: input.source,
    })
    .returning(['id'])
    .executeTakeFirst()

  const runId = Number(run?.id)
  const touched: number[] = []

  for (const execution of input.executions) {
    const test = await testFor(suite, execution.scope, execution.name)

    touched.push(test.id)

    /*
     * A muted failure is recorded as the failure it was. Storing it as
     * anything else would lose the only thing that tells somebody the mute is
     * still needed - and the day the test starts passing again.
     */
    if (execution.result === 'failed')
      test.state === 'muted' ? counts.mutedFailures++ : counts.failed++
    else if (execution.result === 'skipped')
      counts.skipped++
    else
      counts.passed++

    duration += Number(execution.durationMs ?? 0)

    await db
      .insertInto('test_executions')
      .values({
        test_run_id: runId,
        managed_test_id: test.id,
        result: execution.result,
        duration_ms: Math.max(0, Math.round(Number(execution.durationMs ?? 0))),
        retries: Math.max(0, Math.round(Number(execution.retries ?? 0))),
        failure_message: execution.failureMessage ? String(execution.failureMessage).slice(0, 4000) : null,
        failure_stack: execution.failureStack ? String(execution.failureStack).slice(0, 20_000) : null,
        workflow_job_id: execution.workflowJobId ?? null,
        tags: (execution.tags ?? []).filter(tag => tag.includes('=')).join('\n') || null,
      })
      .execute()
  }

  await db
    .updateTable('test_runs')
    .set({
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      muted_failures: counts.mutedFailures,
      duration_ms: duration,
    })
    .where('id', '=', runId)
    .execute()

  const newlyFlaky = await detectFlakes(touched, { repositoryId: input.repositoryId, headSha: input.headSha })

  /*
   * And whoever is waiting to hear that a suite reported.
   *
   * The totals rather than the executions: two thousand results is two thousand
   * rows, and a delivery carrying them is one that times out on exactly the
   * repositories that matter. The run id is in the body, so a receiver that
   * wants the detail asks the API for it.
   *
   * Never awaited for its effect and never able to fail an ingestion: a webhook
   * is a consequence of the results being recorded, not a condition of it.
   */
  await announceRecorded({
    repositoryId: input.repositoryId,
    suite: suiteSlug,
    runId,
    branch: input.branch ?? '',
    headSha: input.headSha,
    counts,
    duration,
    workflowRunId: input.workflowRunId ?? null,
  }).catch(() => null)

  return {
    ok: true,
    reason: `recorded ${input.executions.length} results`,
    runId,
    duplicate: false,
    // Muted failures are excluded, which is the whole of what a mute does here.
    verdict: counts.failed > 0 ? 'failed' : 'passed',
    counts,
    newlyFlaky,
  }
}

/**
 * Tests that changed their mind, over the recent window.
 *
 * Two shapes count, and both are what people mean by flaky:
 *
 * - **Disagreeing about one commit.** The code did not change between those
 *   runs, so the test did.
 * - **Passing after a retry.** A test that needed three attempts did not pass;
 *   it failed twice and then got lucky, and a reporter that records only the
 *   final verdict has thrown the fact away before anybody could act on it.
 *
 * Returns the ones that were *not* already marked, so a caller can say what
 * this run discovered rather than repeating what it already knew.
 */
export async function detectFlakes(testIds: readonly number[], announce?: { repositoryId: number, headSha: string }): Promise<string[]> {
  const newly: string[] = []

  for (const testId of testIds) {
    const rows = await db
      .selectFrom('test_executions')
      .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
      .select([
        'test_executions.result as result',
        'test_executions.retries as retries',
        'test_runs.head_sha as head_sha',
      ])
      .where('test_executions.managed_test_id', '=', testId)
      .orderBy('test_executions.id', 'desc')
      .limit(FLAKE_WINDOW)
      .execute()

    if (rows.length === 0)
      continue

    const byCommit = new Map<string, Set<string>>()

    for (const row of rows) {
      const sha = String(row.head_sha)

      byCommit.set(sha, (byCommit.get(sha) ?? new Set()).add(String(row.result)))
    }

    const disagreed = [...byCommit.values()].some(results => results.has('passed') && results.has('failed'))
    const retried = rows.some(row => String(row.result) === 'passed' && Number(row.retries ?? 0) > 0)

    if (!disagreed && !retried)
      continue

    const test = await db
      .selectFrom('managed_tests')
      .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
      .select([
        'managed_tests.flaky as flaky',
        'managed_tests.name as name',
        'managed_tests.scope as scope',
        'test_suites.slug as suite',
      ])
      .where('managed_tests.id', '=', testId)
      .executeTakeFirst()

    const reason = disagreed
      ? 'Passed and failed on the same commit.'
      : 'Passed only after a retry.'

    await db
      .updateTable('managed_tests')
      .set({
        flaky: true,
        flaky_reason: reason,
        /*
         * Stamped only on the crossing. A test that has been flaky for three
         * weeks and flakes again is not newly flaky, and refreshing the date
         * would make every run in the window look like the first one to hit it
         * - which is exactly the question the impact number asks.
         */
        ...(test && test.flaky !== true ? { flaky_since: new Date().toISOString() } : {}),
      })
      .where('id', '=', testId)
      .execute()

    if (test && test.flaky !== true) {
      newly.push(`${String(test.scope ?? '')}${test.scope ? ' › ' : ''}${String(test.name)}`)

      /*
       * The transition, to whatever is listening.
       *
       * Emitted here rather than by the caller because *here* is where the
       * crossing is known: the row said steady a line ago and says flaky now,
       * and reconstructing that afterwards would mean asking the database what
       * it used to think.
       *
       * Never awaited for its effect and never able to fail an ingestion. A
       * webhook is a consequence of the result being recorded, not a condition
       * of it.
       */
      if (announce) {
        await announceFlaky({
          repositoryId: announce.repositoryId,
          headSha: announce.headSha,
          id: testId,
          suite: String(test.suite ?? ''),
          scope: String(test.scope ?? ''),
          name: String(test.name),
          reason,
        }).catch(() => null)
      }
    }
  }

  return newly
}

/** The suite by slug, created on first sight. */
/** The slug a suite name becomes, in one place so the row and the webhook agree. */
function slugOfSuite(name: string): string {
  const trimmed = String(name ?? '').trim() || 'default'

  return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'default'
}

async function suiteFor(repositoryId: number, slug: string): Promise<number> {
  const name = String(slug ?? '').trim() || 'default'
  const key = slugOfSuite(name)

  const existing = await db
    .selectFrom('test_suites')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('slug', '=', key)
    .executeTakeFirst()

  if (existing)
    return Number(existing.id)

  const created = await db
    .insertInto('test_suites')
    .values({ repository_id: repositoryId, name: name.slice(0, 100), slug: key })
    .returning(['id'])
    .executeTakeFirst()

  return Number(created?.id)
}

/**
 * The test by suite, scope and name, created on first sight.
 *
 * A rename makes a new row. Guessing that two similar names are one test is
 * guessing about intent, and being wrong loses the history of the test that
 * still exists - which is the history somebody is about to make a decision
 * from.
 */
async function testFor(suiteId: number, scope: string, name: string): Promise<{ id: number, state: string }> {
  const cleanScope = String(scope ?? '').slice(0, 500)
  const cleanName = String(name ?? '').slice(0, 500) || 'a test'

  const existing = await db
    .selectFrom('managed_tests')
    .select(['id', 'state'])
    .where('test_suite_id', '=', suiteId)
    .where('scope', '=', cleanScope)
    .where('name', '=', cleanName)
    .executeTakeFirst()

  if (existing)
    return { id: Number(existing.id), state: String(existing.state) }

  const created = await db
    .insertInto('managed_tests')
    .values({ test_suite_id: suiteId, scope: cleanScope, name: cleanName, state: 'enabled' })
    .returning(['id'])
    .executeTakeFirst()

  return { id: Number(created?.id), state: 'enabled' }
}

/**
 * One test that just became unreliable, to programs.
 *
 * Webhook-only, like the monitor transitions: nobody wants an inbox entry per
 * flaky test, and the receiver that does want to know is a dashboard or an
 * agent deciding whether a red build is evidence about the diff in front of it.
 */
async function announceFlaky(input: {
  repositoryId: number
  headSha: string
  id: number
  suite: string
  scope: string
  name: string
  reason: string
}): Promise<void> {
  const repository = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()

  if (!repository)
    return

  const owner: any = String(repository.owner_type) === 'user'
    ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
    : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()

  await notifyProgramsOnly('test:flaky', {
    // Nobody clicked; a result arrived and a threshold was crossed. Zero reads
    // as "the system" everywhere else this happens.
    actorId: 0,
    actorHandle: '',
    repositoryId: input.repositoryId,
    owner: String(owner?.handle ?? ''),
    repository: String(repository.name ?? ''),
    subjectType: 'repository',
    subjectId: input.repositoryId,
    title: `${input.scope ? `${input.scope} › ` : ''}${input.name} is flaky`,
    test: {
      id: input.id,
      suite: input.suite,
      scope: input.scope,
      name: input.name,
      // Which of the two shapes it was, because they mean different things to
      // whoever reads this: disagreeing about one commit is usually a race,
      // passing only after a retry is usually a timeout.
      reason: input.reason,
      head_sha: input.headSha,
    },
  })
}

/**
 * Tell the programs that a suite reported.
 *
 * Separate from the flaky announcement because the two are different facts: one
 * is "a run happened, here are the totals", the other is "this test crossed a
 * threshold". A receiver wanting the first every time and the second rarely
 * should not have to filter one out of the other.
 */
async function announceRecorded(input: {
  repositoryId: number
  suite: string
  runId: number
  branch: string
  headSha: string
  counts: { passed: number, failed: number, skipped: number, mutedFailures: number }
  duration: number
  workflowRunId: number | null
}): Promise<void> {
  const repository = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()

  if (!repository)
    return

  const owner = String(repository.owner_type) === 'user'
    ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
    : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()

  await notifyProgramsOnly('test:recorded', {
    // Nobody clicked: a collector posted a report. Zero reads as "the system"
    // everywhere else this happens.
    actorId: 0,
    actorHandle: '',
    repositoryId: input.repositoryId,
    owner: String(owner?.handle ?? ''),
    repository: String(repository.name ?? ''),
    subjectType: 'repository',
    subjectId: input.repositoryId,
    title: `${input.suite}: ${input.counts.passed} passed, ${input.counts.failed} failed`,
    suite: {
      suite: input.suite,
      run: input.runId,
      branch: input.branch,
      head_sha: input.headSha,
      passed: input.counts.passed,
      failed: input.counts.failed,
      skipped: input.counts.skipped,
      muted_failures: input.counts.mutedFailures,
      duration_ms: input.duration,
      workflow_run_id: input.workflowRunId,
    },
  })
}
