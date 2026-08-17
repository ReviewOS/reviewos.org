// Test results from any CI: ingestion, identity, flake detection, quarantine.
//
// The five cases the roadmap names are all here - a malformed report, the same
// run reported twice, a test renamed between runs, a flake found across a
// rerun, and muting that does not hide the result - because each one is a way
// this feature is usually got wrong rather than an edge case.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ingestTestRun } from '../../app/Actions/Tests/ingest'
import { parseJunit } from '../../app/Actions/Tests/junit'

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
    for (const [scope, level] of [['checks', 'write'], ['contents', 'read']] as Array<[string, string]>)
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
    expect(tests.sometimes!.flaky).toBe(false)

    const rerun = await ingest({
      key: 'flake-2',
      headSha: sha,
      executions: [{ scope: 'src/f.ts', name: 'sometimes', result: 'passed' }],
    })

    tests = await testsIn('unit')

    expect(tests.sometimes!.flaky).toBe(true)
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

    expect((await testsIn('unit')).eventually!.flaky).toBe(true)
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

    expect((await testsIn('unit')).steady!.flaky).toBe(false)
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
