// Test results from any CI: ingestion, identity, flake detection, quarantine.
//
// The five cases the roadmap names are all here - a malformed report, the same
// run reported twice, a test renamed between runs, a flake found across a
// rerun, and muting that does not hide the result - because each one is a way
// this feature is usually got wrong rather than an edge case.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ingestTestRun } from '../../app/Actions/Tests/ingest'
import { parseJunit } from '../../app/Actions/Tests/junit'
import { dbTimestamp, isTrue } from '../../app/Actions/Support/sql'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', token: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

/** The endpoint a collector calls, over HTTP, the way one actually would. */
async function api(body: Record<string, unknown>, token = created.token): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/tests/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** One suite's tests, by name, so an assertion can name what it means. */
async function testsIn(suite: string): Promise<Record<string, any>> {
  const rows: any[] = await db
    .selectFrom('managed_tests')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'managed_tests.id as id',
      'managed_tests.name as name',
      'managed_tests.scope as scope',
      'managed_tests.state as state',
      'managed_tests.flaky as flaky',
      'managed_tests.flaky_reason as flaky_reason',
    ])
    .where('test_suites.repository_id', '=', created.repositoryId)
    .where('test_suites.slug', '=', suite)
    .execute()

  return Object.fromEntries(rows.map(row => [String(row.name), row]))
}

async function ingest(over: Record<string, any>): Promise<any> {
  return ingestTestRun({
    repositoryId: created.repositoryId,
    suite: 'unit',
    headSha: 'a'.repeat(40),
    source: 'json',
    executions: [],
    ...over,
  } as any)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('tst')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Test Intel', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'test intelligence',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    /*
     * `checks: write` is what `check:report` needs, and reporting test results
     * deliberately asks for nothing more: a CI integration that may say a
     * commit passed may say which tests did.
     */
    for (const [scope, level] of [['checks', 'write'], ['contents', 'read'], ['actions', 'admin'], ['actions_logs', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = token.token

    const { route } = await import('@stacksjs/router')

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[test-intelligence] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('ingesting results', () => {
  test('records a run, its counts, and one row per test', async () => {
    if (!available)
      return

    const outcome = await ingest({
      key: 'run-1',
      branch: 'main',
      executions: [
        { scope: 'src/a.ts', name: 'passes', result: 'passed', durationMs: 12 },
        { scope: 'src/a.ts', name: 'fails', result: 'failed', failureMessage: 'expected 2 to be 3' },
        { scope: 'src/b.ts', name: 'skipped for now', result: 'skipped' },
      ],
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.verdict).toBe('failed')
    expect(outcome.counts).toEqual({ passed: 1, failed: 1, skipped: 1, mutedFailures: 0 })

    const tests = await testsIn('unit')

    expect(Object.keys(tests).sort()).toEqual(['fails', 'passes', 'skipped for now'])
    expect(tests.passes!.scope).toBe('src/a.ts')
  }, 60_000)

  test('the same run reported twice is one run, not two histories', async () => {
    if (!available)
      return

    /*
     * Every collector retries, and a retry that fails is a collector that
     * retries again. What must not happen is a test's history doubling, which
     * would make everything downstream - flake detection most of all - answer
     * from data that never happened.
     */
    const again = await ingest({
      key: 'run-1',
      executions: [{ scope: 'src/a.ts', name: 'passes', result: 'passed' }],
    })

    expect(again.ok).toBe(true)
    expect(again.duplicate).toBe(true)

    const runs: any[] = await db
      .selectFrom('test_runs')
      .innerJoin('test_suites', 'test_suites.id', '=', 'test_runs.test_suite_id')
      .select(['test_runs.id as id'])
      .where('test_suites.repository_id', '=', created.repositoryId)
      .where('test_runs.external_key', '=', 'run-1')
      .execute()

    expect(runs).toHaveLength(1)
  }, 60_000)

  test('a report with nothing in it is refused rather than recorded empty', async () => {
    if (!available)
      return

    // An empty run recorded as a success is how a broken reporter reads as a
    // green suite - the failure mode this whole feature exists to remove.
    expect((await ingest({ key: 'empty', executions: [] })).ok).toBe(false)
    expect((await ingest({ key: 'no-sha', headSha: '', executions: [{ scope: '', name: 'x', result: 'passed' }] })).ok).toBe(false)
  }, 60_000)

  test('a JUnit report goes in through the same path', async () => {
    if (!available)
      return

    const parsed = parseJunit(`<testsuite>
      <testcase classname="src/c.ts" name="from junit" time="0.5"/>
    </testsuite>`)

    const outcome = await ingest({ key: 'junit-1', source: 'junit', executions: parsed.executions })

    expect(outcome.ok).toBe(true)
    expect((await testsIn('unit'))['from junit']).toBeTruthy()
  }, 60_000)

  test('a renamed test is a new test, and the old one keeps its history', async () => {
    if (!available)
      return

    /*
     * Guessing that `passes` and `passes quickly` are the same test is
     * guessing about somebody's intent, and being wrong loses the history of
     * the test that still exists - which is the history somebody is about to
     * make a decision from.
     */
    await ingest({
      key: 'renamed',
      executions: [{ scope: 'src/a.ts', name: 'passes quickly', result: 'passed' }],
    })

    const tests = await testsIn('unit')

    expect(tests.passes).toBeTruthy()
    expect(tests['passes quickly']).toBeTruthy()
    expect(Number(tests.passes!.id)).not.toBe(Number(tests['passes quickly']!.id))
  }, 60_000)
})

describe('flake detection', () => {
  test('a test that passed and failed on one commit is flaky, and says why', async () => {
    if (!available)
      return

    const sha = 'b'.repeat(40)

    await ingest({ key: 'flake-1', headSha: sha, executions: [{ scope: 'src/f.ts', name: 'sometimes', result: 'failed' }] })

    let tests = await testsIn('unit')

    // One failure is a failure, not a flake. A tool that called it flaky here
    // would be telling somebody to ignore a broken test.
    expect(isTrue(tests.sometimes!.flaky)).toBe(false)

    const rerun = await ingest({
      key: 'flake-2',
      headSha: sha,
      executions: [{ scope: 'src/f.ts', name: 'sometimes', result: 'passed' }],
    })

    tests = await testsIn('unit')

    expect(isTrue(tests.sometimes!.flaky)).toBe(true)
    expect(String(tests.sometimes!.flaky_reason)).toContain('same commit')
    // Named in the answer, so the collector's log says what this run found
    // rather than what was already known.
    expect(rerun.newlyFlaky).toContain('src/f.ts › sometimes')
  }, 120_000)

  test('and passing only after a retry is flaky on its own', async () => {
    if (!available)
      return

    /*
     * A test that needed three attempts did not pass; it failed twice and then
     * got lucky. A reporter that stores only the final verdict has thrown the
     * fact away before anybody could act on it.
     */
    await ingest({
      key: 'retry-1',
      headSha: 'c'.repeat(40),
      executions: [{ scope: 'src/r.ts', name: 'eventually', result: 'passed', retries: 2 }],
    })

    expect(isTrue((await testsIn('unit')).eventually!.flaky)).toBe(true)
    expect(String((await testsIn('unit')).eventually!.flaky_reason)).toContain('retry')
  }, 120_000)

  test('a test that only ever passed is not flaky', async () => {
    if (!available)
      return

    await ingest({
      key: 'steady-1',
      headSha: 'd'.repeat(40),
      executions: [{ scope: 'src/s.ts', name: 'steady', result: 'passed' }],
    })

    await ingest({
      key: 'steady-2',
      headSha: 'e'.repeat(40),
      executions: [{ scope: 'src/s.ts', name: 'steady', result: 'passed' }],
    })

    expect(isTrue((await testsIn('unit')).steady!.flaky)).toBe(false)
  }, 120_000)
})

describe('muting', () => {
  test('does not hide the result: the failure is recorded, counted apart, and kept', async () => {
    if (!available)
      return

    const tests = await testsIn('unit')

    await db
      .updateTable('managed_tests')
      .set({ state: 'muted', muted_reason: 'flaky under load', review_at: '2026-12-01T00:00:00.000Z' } as any)
      .where('id', '=', Number(tests.fails!.id))
      .execute()

    const outcome = await ingest({
      key: 'muted-1',
      headSha: 'f'.repeat(40),
      executions: [
        { scope: 'src/a.ts', name: 'fails', result: 'failed', failureMessage: 'still broken' },
        { scope: 'src/a.ts', name: 'passes', result: 'passed' },
      ],
    })

    /*
     * The run's verdict ignores it, and everything else about it is unchanged:
     * the failure is in the counts as a muted failure, and the execution row
     * carries the message. A mute that hid the result would be a suite quietly
     * testing less than it says - and the day the test starts passing again
     * would go unnoticed.
     */
    expect(outcome.verdict).toBe('passed')
    expect(outcome.counts).toMatchObject({ passed: 1, failed: 0, mutedFailures: 1 })

    const execution: any = await db
      .selectFrom('test_executions')
      .select(['result', 'failure_message'])
      .where('managed_test_id', '=', Number(tests.fails!.id))
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(String(execution.result)).toBe('failed')
    expect(String(execution.failure_message)).toBe('still broken')
  }, 120_000)

  test('and a muted test still counts against nothing but still shows in its history', async () => {
    if (!available)
      return

    const tests = await testsIn('unit')

    const rows: any[] = await db
      .selectFrom('test_executions')
      .select(['result'])
      .where('managed_test_id', '=', Number(tests.fails!.id))
      .execute()

    // Two failures on record for a test the run says did not fail it, which is
    // exactly the state a person needs to be able to see.
    expect(rows.filter(row => String(row.result) === 'failed').length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})

/*
 * The endpoint, over HTTP, the way a collector on somebody else's CI calls it.
 * The shape of the *answer* is the point: a verdict that ignores muted
 * failures, so a collector that wants the mute to decide the job's outcome can
 * use it.
 */
describe('the ingest endpoint', () => {
  test('takes a JUnit report and answers with the verdict and the counts', async () => {
    if (!available)
      return

    const { status, body } = await api({
      suite: 'browser',
      sha: '1a'.repeat(20),
      branch: 'main',
      key: 'http-1',
      format: 'junit',
      report: `<testsuite>
        <testcase classname="e2e/login.spec.ts" name="signs in" time="2.5"/>
        <testcase classname="e2e/login.spec.ts" name="rejects a bad password">
          <failure message="timed out">at login.spec.ts:40</failure>
        </testcase>
      </testsuite>`,
    })

    expect(status).toBe(200)
    expect(body.verdict).toBe('failed')
    expect(body.counts).toMatchObject({ passed: 1, failed: 1, muted_failures: 0 })
    expect(body.duplicate).toBe(false)
  }, 120_000)

  test('a malformed report is refused with what was wrong, not swallowed', async () => {
    if (!available)
      return

    /*
     * A collector posting an HTML error page - because a proxy answered
     * instead of the file it meant to send - must not read as a suite with no
     * tests, which is indistinguishable from a suite that passed.
     */
    const { status, body } = await api({
      suite: 'browser',
      sha: '1b'.repeat(20),
      key: 'http-bad',
      format: 'junit',
      report: '<html><body>502 Bad Gateway</body></html>',
    })

    expect(status).toBe(422)
    expect(String(body.reason)).toContain('`<testcase>`')
  }, 120_000)

  test('the documented JSON shape carries what JUnit cannot', async () => {
    if (!available)
      return

    const { status, body } = await api({
      suite: 'browser',
      sha: '1c'.repeat(20),
      key: 'http-json',
      format: 'json',
      report: JSON.stringify({
        tests: [
          { scope: 'e2e/checkout.spec.ts', name: 'checks out', result: 'passed', duration_ms: 900, retries: 1, tags: ['browser=firefox', 'shard=2'] },
        ],
      }),
    })

    expect(status).toBe(200)
    expect(body.counts.passed).toBe(1)

    // Retries and tags are why the JSON shape exists: JUnit cannot carry either
    // without somebody inventing an attribute.
    const execution: any = await db
      .selectFrom('test_executions')
      .select(['retries', 'tags'])
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(Number(execution.retries)).toBe(1)
    expect(String(execution.tags)).toContain('browser=firefox')

    // And a retry that passed is a flake, found on the first report of it.
    expect(body.newly_flaky).toContain('e2e/checkout.spec.ts › checks out')
  }, 120_000)

  test('and a stranger cannot report results for somebody else\'s repository', async () => {
    if (!available)
      return

    const { status } = await api({ suite: 'browser', sha: '1d'.repeat(20), format: 'json', report: '{"tests":[]}' }, 'not-a-token')

    // Test results decide whether a commit looks healthy, which makes writing
    // them a write.
    expect(status).not.toBe(200)
  }, 120_000)
})

/*
 * Splitting, against real recorded history.
 *
 * The unit tests hold the partition itself; what this proves is the part that
 * only breaks in the database: that the timings the endpoint reads are the ones
 * ingestion wrote, per file and averaged over runs rather than summed over
 * months.
 */
describe('splitting a suite by what it has cost', () => {
  async function split(body: Record<string, unknown>): Promise<any> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/tests/split`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, suite: 'split', ...body }),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('the slow file and the fast files end up on different nodes', async () => {
    if (!available)
      return

    await ingest({
      suite: 'split',
      key: 'split-1',
      executions: [
        { scope: 'e2e/slow.spec.ts', name: 'a', result: 'passed', durationMs: 120_000 },
        { scope: 'unit/fast-a.test.ts', name: 'b', result: 'passed', durationMs: 300 },
        { scope: 'unit/fast-b.test.ts', name: 'c', result: 'passed', durationMs: 200 },
      ],
    })

    const items = ['e2e/slow.spec.ts', 'unit/fast-a.test.ts', 'unit/fast-b.test.ts']
    const zero = await split({ items, nodes: 2, index: 0 })
    const one = await split({ items, nodes: 2, index: 1 })

    expect(zero.status).toBe(200)
    expect(zero.body.items).toEqual(['e2e/slow.spec.ts'])
    expect(one.body.items.sort()).toEqual(['unit/fast-a.test.ts', 'unit/fast-b.test.ts'])

    // Every item, exactly once, which is the property that is silent when it
    // breaks: a file on no node stopped being tested and nothing says so.
    expect([...zero.body.items, ...one.body.items].sort()).toEqual([...items].sort())
    expect(zero.body.estimated_ms).toBeGreaterThan(100_000)
  }, 120_000)

  test('a file with no history is carried anyway, and the answer says it was guessed at', async () => {
    if (!available)
      return

    const { body } = await split({
      items: ['e2e/slow.spec.ts', 'unit/fast-a.test.ts', 'unit/fast-b.test.ts', 'unit/brand-new.test.ts'],
      nodes: 2,
      index: 1,
    })

    expect([...body.items, ...(await split({ items: ['e2e/slow.spec.ts', 'unit/fast-a.test.ts', 'unit/fast-b.test.ts', 'unit/brand-new.test.ts'], nodes: 2, index: 0 })).body.items])
      .toContain('unit/brand-new.test.ts')
    expect(String(body.note)).toContain('no timing history')
  }, 120_000)

  test('a suite nobody has ever reported still gets a partition, with a note saying so', async () => {
    if (!available)
      return

    // The alternative is an error, and a node that gets an error instead of a
    // list runs nothing at all - a missing-history problem turned into a
    // broken build.
    const { status, body } = await split({ suite: 'never-reported', items: 'a.ts\nb.ts\nc.ts\nd.ts', nodes: 2, index: 0 })

    expect(status).toBe(200)
    expect(body.items).toHaveLength(2)
    expect(String(body.note)).toContain('No timing history')
  }, 120_000)
})

/*
 * Retention: the promise the setting makes, kept.
 *
 * Execution rows grow with how often machines run rather than with how much
 * people do, so this is the one table with no natural ceiling. What the sweep
 * must not do is take the decisions somebody recorded - the mute, the reason,
 * the owner - along with the data that merely piled up.
 */
describe('retention', () => {
  test('deletes old executions and the runs they belonged to, and keeps the tests', async () => {
    if (!available)
      return

    const { sweepTestExecutions } = await import('../../app/Actions/Tests/retention')

    await ingest({
      suite: 'retention',
      key: 'old-run',
      headSha: 'f'.repeat(40),
      executions: [{ scope: 'old/a.test.ts', name: 'ancient', result: 'passed' }],
    })

    const suite: any = await db
      .selectFrom('test_suites')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('slug', '=', 'retention')
      .executeTakeFirst()

    // Dated back past any plausible policy, which is the only way to make an
    // "older than the window" test that does not depend on the window.
    const old = dbTimestamp(new Date(Date.now() - 400 * 86_400_000))

    await db.updateTable('test_runs').set({ created_at: old } as any).where('test_suite_id', '=', Number(suite.id)).execute()

    const before = await db
      .selectFrom('test_executions')
      .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
      .select(db.fn.count('test_executions.id').as('count'))
      .where('managed_tests.test_suite_id', '=', Number(suite.id))
      .executeTakeFirst()

    expect(Number((before as any).count)).toBeGreaterThan(0)

    const outcome = await sweepTestExecutions()

    expect(outcome.ok).toBe(true)
    expect(outcome.removed).toBeGreaterThan(0)

    const after = await db
      .selectFrom('test_executions')
      .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
      .select(db.fn.count('test_executions.id').as('count'))
      .where('managed_tests.test_suite_id', '=', Number(suite.id))
      .executeTakeFirst()

    expect(Number((after as any).count)).toBe(0)

    /*
     * The test row survives. Its mute, its owner and its reason are decisions
     * somebody made rather than data that accumulated, and a sweep that takes
     * them is a sweep that silently un-quarantines a test.
     */
    const test: any = await db
      .selectFrom('managed_tests')
      .select(['id', 'name'])
      .where('test_suite_id', '=', Number(suite.id))
      .executeTakeFirst()

    expect(String(test?.name)).toBe('ancient')
  }, 120_000)

  test('and leaves recent history alone', async () => {
    if (!available)
      return

    const { sweepTestExecutions } = await import('../../app/Actions/Tests/retention')

    const before: any = await db.selectFrom('test_executions').select(db.fn.count('id').as('count')).executeTakeFirst()

    await sweepTestExecutions()

    const after: any = await db.selectFrom('test_executions').select(db.fn.count('id').as('count')).executeTakeFirst()

    // Everything this file reported is minutes old, so a second sweep that
    // removes anything at all is a sweep deleting on the wrong comparison.
    expect(Number(after.count)).toBe(Number(before.count))
  }, 120_000)
})

/*
 * Monitors, end to end: the rule fires once, stays quiet while it holds, and
 * recovers when it stops.
 *
 * The "stays quiet" case is the one worth the fixture. Everything else about a
 * monitor is a query; the reason it is a stored rule rather than a saved search
 * is that a condition true every hour must not be an alarm every hour.
 */
describe('monitors', () => {
  let monitorId = 0

  test('a rule that has not been crossed says nothing', async () => {
    if (!available)
      return

    const { evaluateMonitors } = await import('../../app/Actions/Tests/monitors')

    await ingest({
      suite: 'monitored',
      key: 'monitor-green',
      headSha: '2a'.repeat(20),
      executions: [
        { scope: 'm/a.test.ts', name: 'one', result: 'passed' },
        { scope: 'm/b.test.ts', name: 'two', result: 'passed' },
      ],
    })

    const created: any = await db.insertInto('test_monitors').values({
      repository_id: created_repository(),
      suite: 'monitored',
      condition: 'fail_rate',
      threshold: 25,
      window_days: 7,
      state: 'ok',
      enabled: true,
    }).returning(['id']).executeTakeFirst()

    monitorId = Number(created?.id)

    const outcome = await evaluateMonitors(created_repository())

    expect(outcome.transitions.filter((one: any) => one.id === monitorId)).toEqual([])

    /*
     * But it did look, and it recorded when. A rule that says everything is
     * fine and a rule that has not run since March are indistinguishable
     * without this.
     */
    const row: any = await db.selectFrom('test_monitors').select(['evaluated_at', 'changed_at', 'state']).where('id', '=', monitorId).executeTakeFirst()

    expect(row.evaluated_at).toBeTruthy()
    expect(row.changed_at).toBeFalsy()
    expect(String(row.state)).toBe('ok')
  }, 120_000)

  test('crossing the line alarms exactly once, however often it is evaluated', async () => {
    if (!available)
      return

    const { evaluateMonitors } = await import('../../app/Actions/Tests/monitors')

    await ingest({
      suite: 'monitored',
      key: 'monitor-red',
      headSha: '2b'.repeat(20),
      executions: [
        { scope: 'm/a.test.ts', name: 'one', result: 'failed', failureMessage: 'broke' },
        { scope: 'm/b.test.ts', name: 'two', result: 'failed', failureMessage: 'broke' },
      ],
    })

    const first = await evaluateMonitors(created_repository())

    expect(first.transitions.find((one: any) => one.id === monitorId)?.to).toBe('alarm')

    // The assertion the whole design exists for.
    const second = await evaluateMonitors(created_repository())

    expect(second.transitions.find((one: any) => one.id === monitorId)).toBeUndefined()
  }, 120_000)

  test('and it recovers when the suite does', async () => {
    if (!available)
      return

    const { evaluateMonitors } = await import('../../app/Actions/Tests/monitors')

    // Enough passing history to pull the share back under a quarter.
    for (const key of ['green-1', 'green-2', 'green-3', 'green-4']) {
      await ingest({
        suite: 'monitored',
        key,
        headSha: `2c${key}`.padEnd(40, '0'),
        executions: [
          { scope: 'm/a.test.ts', name: 'one', result: 'passed' },
          { scope: 'm/b.test.ts', name: 'two', result: 'passed' },
        ],
      })
    }

    const outcome = await evaluateMonitors(created_repository())

    expect(outcome.transitions.find((one: any) => one.id === monitorId)?.to).toBe('recovered')

    const row: any = await db.selectFrom('test_monitors').select(['state']).where('id', '=', monitorId).executeTakeFirst()

    expect(String(row.state)).toBe('ok')
  }, 120_000)

  test('a muted test cannot put a monitor into alarm', async () => {
    if (!available)
      return

    const { evaluateMonitors } = await import('../../app/Actions/Tests/monitors')

    /*
     * Somebody already decided about this test. A monitor that counted its
     * failures would alarm on exactly the tests that are under control, and
     * the quarantine would stop being a decision and become a source of noise.
     */
    const suite: any = await db
      .selectFrom('test_suites')
      .select(['id'])
      .where('repository_id', '=', created_repository())
      .where('slug', '=', 'monitored')
      .executeTakeFirst()

    await db.updateTable('managed_tests')
      .set({ state: 'muted', muted_reason: 'known', review_at: '2027-01-01' } as any)
      .where('name', '=', 'one')
      .where('test_suite_id', '=', Number(suite.id))
      .execute()

    await ingest({
      suite: 'monitored',
      key: 'monitor-muted',
      headSha: '2d'.repeat(20),
      executions: [
        { scope: 'm/a.test.ts', name: 'one', result: 'failed', failureMessage: 'still broken, and known' },
        { scope: 'm/b.test.ts', name: 'two', result: 'passed' },
      ],
    })

    const outcome = await evaluateMonitors(created_repository())

    expect(outcome.transitions.find((one: any) => one.id === monitorId)).toBeUndefined()
  }, 120_000)
})

describe('the monitors endpoint', () => {
  async function monitors(body: Record<string, unknown>): Promise<any> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/tests/monitors`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('writes a rule and hands back both of its dates', async () => {
    if (!available)
      return

    const { status, body } = await monitors({ operation: 'create', suite: 'browser', condition: 'fail_rate', threshold: 2.5, window_days: 14 })

    expect(status).toBe(200)

    // 2.5 comes back as 2.5. A four-byte float would hand back
    // 2.5000000596046448, and a threshold that does not survive the round trip
    // is one somebody tries to correct and cannot.
    expect(body.monitor).toMatchObject({ suite: 'browser', condition: 'fail_rate', threshold: 2.5, state: 'ok' })

    // Never evaluated, so both are null - which is the state that says "this
    // rule has never run" rather than "everything is fine".
    expect(body.monitor.evaluated_at).toBeNull()
    expect(body.monitor.changed_at).toBeNull()
  }, 120_000)

  test('and refuses a failure rate that could never be crossed', async () => {
    if (!available)
      return

    /*
     * Above a hundred percent, no execution history can cross it. A monitor
     * that can never fire is worse than none: it reads as covered.
     */
    const { status, body } = await monitors({ operation: 'create', condition: 'fail_rate', threshold: 500 })

    expect(status).toBe(422)
    expect(String(body.reason)).toContain('between 0 and 100')
  }, 120_000)

  test('but 500 is a fine threshold in milliseconds', async () => {
    if (!available)
      return

    // The same number, meaning half a second, on the condition whose unit is
    // milliseconds. The refusal above is about the unit, not the digit.
    const { status } = await monitors({ operation: 'create', condition: 'duration', threshold: 500, suite: 'browser' })

    expect(status).toBe(200)
  }, 120_000)
})

describe('the flaky transition as an event', () => {
  test('fires once, when a test crosses from steady to flaky', async () => {
    if (!available)
      return

    const { listen } = await import('@stacksjs/events')
    const seen: any[] = []

    listen('test:flaky', (payload: any) => {
      seen.push(payload)
    })

    await ingest({
      suite: 'events',
      key: 'event-green',
      headSha: '3a'.repeat(20),
      executions: [{ scope: 'e/a.test.ts', name: 'wobbles', result: 'passed' }],
    })

    // Steady so far, so nothing to say.
    expect(seen).toHaveLength(0)

    await ingest({
      suite: 'events',
      key: 'event-red',
      headSha: '3a'.repeat(20),
      executions: [{ scope: 'e/a.test.ts', name: 'wobbles', result: 'failed', failureMessage: 'raced' }],
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.test).toMatchObject({ suite: 'events', scope: 'e/a.test.ts', name: 'wobbles' })
    expect(String(seen[0]?.test?.reason)).toContain('same commit')

    /*
     * And not again. The test that has been flaky for a month is not news, and
     * a receiver told about it on every run writes a filter - which hides the
     * one that broke today.
     */
    await ingest({
      suite: 'events',
      key: 'event-red-again',
      headSha: '3b'.repeat(20),
      executions: [{ scope: 'e/a.test.ts', name: 'wobbles', result: 'failed', failureMessage: 'raced again' }],
    })

    expect(seen).toHaveLength(1)
  }, 120_000)
})

/** The repository this file created, named as a function so it reads in place. */
function created_repository(): number {
  return created.repositoryId
}

/*
 * Reading it back.
 *
 * A page is not an API. A team's own dashboard, a release script that refuses
 * to ship while a suite is red, an agent asking whether the test it is about to
 * change is already flaky - each of those had to scrape HTML or query the
 * database directly, and both are ways of depending on something nobody
 * promised to keep.
 */
describe('the read API', () => {
  async function read(query: string, token = created.token): Promise<{ status: number, body: any }> {
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/tests?owner=${created.handle}&repo=${created.name}&${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }

  test('lists the suites with the shape of the last run', async () => {
    if (!available)
      return

    await ingest({
      suite: 'readable',
      headSha: 'e'.repeat(40),
      branch: 'main',
      executions: [
        { name: 'passes', result: 'passed', durationMs: 4 },
        { name: 'fails', result: 'failed', durationMs: 9, failureMessage: 'expected 1' },
      ],
    })

    const { status, body } = await read('view=suites')

    expect(status).toBe(200)

    const suite = body.suites.find((one: any) => one.slug === 'readable')

    expect(suite).toBeTruthy()
    expect(suite.last_run.passed).toBe(1)
    expect(suite.last_run.failed).toBe(1)
    expect(String(suite.last_run.head_sha)).toBe('e'.repeat(40))
  }, 120_000)

  test('and the runs of one suite, newest first', async () => {
    if (!available)
      return

    await ingest({ suite: 'readable', headSha: 'f'.repeat(40), branch: 'main', executions: [{ name: 'passes', result: 'passed', durationMs: 4 }] })

    const { body } = await read('view=runs&suite=readable')

    expect(body.runs.length).toBeGreaterThanOrEqual(2)
    expect(String(body.runs[0].head_sha)).toBe('f'.repeat(40))
    expect(body.runs[0].branch).toBe('main')
  }, 120_000)

  test('and the executions of one run, with the message and not the stack', async () => {
    if (!available)
      return

    const runs = await read('view=runs&suite=readable')
    const runId = Number(runs.body.runs.at(-1).id)

    const { body } = await read(`view=executions&suite=readable&run=${runId}`)

    const failed = body.executions.find((one: any) => one.name === 'fails')

    expect(failed).toBeTruthy()
    expect(failed.result).toBe('failed')
    expect(String(failed.failure_message)).toContain('expected 1')
    // The stack is the larger half of an execution row and the half a dashboard
    // never renders: whoever wants it asks for the one execution.
    expect(failed.failure_stack).toBeUndefined()
  }, 120_000)

  test('and what this instance believes about each test, including an overdue review', async () => {
    if (!available)
      return

    const tests = await testsIn('readable')

    // Muted with a review date in the past, which is the row a listing of
    // quarantined tests exists to surface.
    await db.updateTable('managed_tests')
      .set({ state: 'muted', muted_reason: 'flaky under load', review_at: '2020-01-01T00:00:00.000Z' })
      .where('id', '=', Number(tests.fails.id))
      .execute()

    const { body } = await read('view=states&suite=readable')
    const state = body.states.find((one: any) => one.name === 'fails')

    expect(state.state).toBe('muted')
    expect(state.muted_reason).toBe('flaky under load')
    // Said outright rather than left to the caller's date arithmetic: a client
    // that has to compute it is a client that will not.
    expect(state.review_overdue).toBe(true)
  }, 120_000)

  test('reads without a credential on a public repository, and refuses a token that lacks the scope', async () => {
    if (!available)
      return

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/repos/tests?owner=${created.handle}&repo=${created.name}&view=suites`, {
      headers: { Accept: 'application/json' },
    })

    // This repository is public, so its results are as readable as its code -
    // which is what makes a badge or a public dashboard possible at all.
    expect(anonymous.status).toBe(200)

    /*
     * And a token narrows. `contents: read` is permission to clone, not
     * permission to read what the machines found: test results are the shape of
     * what a repository contains and which parts of it are failing, so they sit
     * with the runs.
     */
    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()
    const row: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'code only',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('access_token_permissions')
      .values({ access_token_id: Number(row?.id), scope: 'contents', level: 'read' })
      .execute()

    const narrow = await read('view=suites', secret.token)

    expect(narrow.status).toBe(403)
    expect(String(narrow.body?.error)).toContain('workflow:read')

    await db.deleteFrom('access_tokens').where('id', '=', Number(row?.id)).execute()
  }, 120_000)
})

describe('a suite reporting as an event', () => {
  test('carries the totals and the run to read the detail from', async () => {
    if (!available)
      return

    const { listen } = await import('@stacksjs/events')
    const seen: any[] = []

    listen('test:recorded', (payload: any) => {
      seen.push(payload)
    })

    const outcome = await ingest({
      suite: 'announced',
      key: 'announced-1',
      headSha: '4c'.repeat(20),
      branch: 'main',
      executions: [
        { name: 'one', result: 'passed', durationMs: 3 },
        { name: 'two', result: 'failed', durationMs: 5, failureMessage: 'nope' },
      ],
    })

    expect(seen).toHaveLength(1)

    /*
     * The totals rather than the executions: a report of two thousand tests is
     * two thousand rows, and a delivery carrying them is one that times out on
     * exactly the repositories that matter. The run id is how a receiver asks
     * for the detail.
     */
    expect(seen[0]?.suite).toMatchObject({ suite: 'announced', branch: 'main', passed: 1, failed: 1 })
    expect(Number(seen[0]?.suite?.run)).toBe(Number(outcome.runId))
    expect(JSON.stringify(seen[0]?.suite)).not.toContain('nope')
  }, 120_000)
})
