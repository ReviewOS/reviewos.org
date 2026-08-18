import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Reading the test intelligence: suites, runs, executions, and what each test is.
 *
 * The ingestion endpoint has existed since this feature did, and everything
 * else was a page. A page is not an API: a team that wants their own dashboard,
 * a release script that refuses to ship while a suite is red, an agent asking
 * whether the test it is about to change is already flaky - each of those had
 * to scrape HTML or query the database directly, and both of those are ways of
 * depending on something nobody promised to keep.
 *
 * Four shapes, because they answer four different questions: which suites exist
 * and how they are doing, which runs a suite has had, what happened to
 * individual tests in one run, and what this instance currently believes about
 * a test - steady, flaky, muted, and who owns it.
 *
 * **Reading takes `workflow:read`.** Test results say which tests exist and
 * which are failing, which is a shape of a private repository's contents, so
 * it sits with the runs rather than with the repository's public face.
 */
export default new Action({
  name: 'ReadTests',
  description: 'Suites, runs, executions, and the state of each test',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    view: { rule: schema.enum(['suites', 'runs', 'executions', 'states']), required: false },
    suite: { rule: schema.string(), required: false },
    branch: { rule: schema.string(), required: false },
    run: { rule: schema.number(), required: false },
    test: { rule: schema.number(), required: false },
    state: { rule: schema.string(), required: false },
    limit: { rule: schema.number(), required: false },
    cursor: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The rows asked for, newest first, with the cursor for the next page. `next` is null on the last one rather than a cursor that returns nothing.',
      schema: {
        type: 'object',
        properties: {
          suites: { type: 'array', items: { type: 'object' } },
          runs: { type: 'array', items: { type: 'object' } },
          executions: { type: 'array', items: { type: 'object' } },
          states: { type: 'array', items: { type: 'object' } },
          next: { type: 'integer', nullable: true },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    422: { description: 'A view this instance does not have, or a page size outside what it will serve.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)
    const view = String(request.get('view') ?? 'suites').trim() || 'suites'
    const asked = Number(request.get('limit'))
    /*
     * A page size with a ceiling, because these tables are the ones that grow
     * with how often machines run rather than with how much people do: two
     * thousand tests reported on every push is two thousand rows.
     */
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 200) : 50
    const cursor = Number(request.get('cursor'))
    const after = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : null

    if (view === 'suites')
      return response.json({ suites: await suites(repositoryId), next: null })

    // Every other view is scoped to a suite of *this* repository, resolved
    // here so nothing below has to remember to check it. A suite id from
    // somewhere else reads as no such suite, which is what it is to this
    // caller.
    const suiteId = await suiteOf(repositoryId, String(request.get('suite') ?? '').trim())

    if (view === 'runs') {
      if (!suiteId)
        return response.json({ runs: [], next: null })

      const rows = await runs({ suiteId, branch: String(request.get('branch') ?? '').trim(), limit, after })

      return response.json({ runs: rows, next: cursorOf(rows, limit) })
    }

    if (view === 'executions') {
      const rows = await executions({
        repositoryId,
        suiteId,
        runId: Number(request.get('run')) || null,
        testId: Number(request.get('test')) || null,
        limit,
        after,
      })

      return response.json({ executions: rows, next: cursorOf(rows, limit) })
    }

    if (view === 'states') {
      const rows = await states({ repositoryId, suiteId, state: String(request.get('state') ?? '').trim(), limit, after })

      return response.json({ states: rows, next: cursorOf(rows, limit) })
    }

    return response.json({ error: 'No such view', reason: '`suites`, `runs`, `executions` or `states`.' }, 422)
  },
})

/** The cursor for the next page, or null when this was the last one. */
function cursorOf(rows: Array<{ id: number }>, limit: number): number | null {
  return rows.length === limit ? Number(rows[rows.length - 1]?.id ?? 0) || null : null
}

/** One suite of this repository, by name or slug. Null when the caller named none. */
async function suiteOf(repositoryId: number, named: string): Promise<number | null> {
  if (!named)
    return null

  /*
   * Matched here rather than in SQL. A repository has a handful of suites, this
   * builder's expression callback is not the callable form, and the alternative
   * is two round trips to answer one question - by slug, then by name.
   */
  const rows = await db
    .selectFrom('test_suites')
    .select(['id', 'name', 'slug'])
    .where('repository_id', '=', repositoryId)
    .execute()
    .catch(() => [])

  const found = rows.find(row => String(row.slug) === named) ?? rows.find(row => String(row.name) === named)

  return found ? Number(found.id) : null
}

/** Every suite, with the shape of its last run. */
async function suites(repositoryId: number): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .selectFrom('test_suites')
    .select(['id', 'name', 'slug'])
    .where('repository_id', '=', repositoryId)
    .orderBy('name')
    .execute()
    .catch(() => [])

  const described: Array<Record<string, unknown>> = []

  for (const suite of rows) {
    const last = await db
      .selectFrom('test_runs')
      .select(['id', 'branch', 'head_sha', 'passed', 'failed', 'skipped', 'muted_failures', 'duration_ms', 'created_at'])
      .where('test_suite_id', '=', Number(suite.id))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
      .catch(() => null)

    described.push({
      id: Number(suite.id),
      name: String(suite.name),
      slug: String(suite.slug),
      last_run: last
        ? {
            id: Number(last.id),
            branch: String(last.branch ?? ''),
            head_sha: String(last.head_sha ?? ''),
            passed: Number(last.passed ?? 0),
            failed: Number(last.failed ?? 0),
            skipped: Number(last.skipped ?? 0),
            muted_failures: Number(last.muted_failures ?? 0),
            duration_ms: Number(last.duration_ms ?? 0),
            at: last.created_at ? String(last.created_at) : null,
          }
        : null,
    })
  }

  return described
}

/** A suite's runs, newest first. */
async function runs(input: { suiteId: number, branch: string, limit: number, after: number | null }): Promise<Array<Record<string, unknown>> & Array<{ id: number }>> {
  let query = db
    .selectFrom('test_runs')
    .select(['id', 'branch', 'head_sha', 'source', 'external_key', 'workflow_run_id', 'passed', 'failed', 'skipped', 'muted_failures', 'duration_ms', 'created_at'])
    .where('test_suite_id', '=', input.suiteId)

  if (input.branch)
    query = query.where('branch', '=', input.branch)

  if (input.after)
    query = query.where('id', '<', input.after)

  const rows = await query.orderBy('id', 'desc').limit(input.limit).execute().catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    branch: String(row.branch ?? ''),
    head_sha: String(row.head_sha ?? ''),
    source: String(row.source ?? ''),
    external_key: row.external_key ? String(row.external_key) : null,
    workflow_run_id: row.workflow_run_id ? Number(row.workflow_run_id) : null,
    passed: Number(row.passed ?? 0),
    failed: Number(row.failed ?? 0),
    skipped: Number(row.skipped ?? 0),
    // Counted and not counted against the run: a muted test still runs and
    // still reports, which is what makes the day it passes again visible.
    muted_failures: Number(row.muted_failures ?? 0),
    duration_ms: Number(row.duration_ms ?? 0),
    at: row.created_at ? String(row.created_at) : null,
  })) as any
}

/** What happened to individual tests, in one run or for one test over time. */
async function executions(input: {
  repositoryId: number
  suiteId: number | null
  runId: number | null
  testId: number | null
  limit: number
  after: number | null
}): Promise<Array<Record<string, unknown>> & Array<{ id: number }>> {
  /*
   * Joined through to the suite and filtered on the repository, which is the
   * check that matters: a run id and a test id are numbers anybody can
   * increment, and without this the endpoint reads out every repository's
   * results in turn.
   */
  let query = db
    .selectFrom('test_executions')
    .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
    .innerJoin('test_suites', 'test_suites.id', '=', 'test_runs.test_suite_id')
    .innerJoin('managed_tests', 'managed_tests.id', '=', 'test_executions.managed_test_id')
    .select([
      'test_executions.id as id',
      'test_executions.test_run_id as test_run_id',
      'test_executions.managed_test_id as managed_test_id',
      'test_executions.result as result',
      'test_executions.duration_ms as duration_ms',
      'test_executions.retries as retries',
      'test_executions.failure_message as failure_message',
      'test_executions.workflow_job_id as workflow_job_id',
      'managed_tests.name as name',
      'managed_tests.scope as scope',
      'test_runs.branch as branch',
      'test_runs.head_sha as head_sha',
    ])
    .where('test_suites.repository_id', '=', input.repositoryId)

  if (input.suiteId)
    query = query.where('test_runs.test_suite_id', '=', input.suiteId)

  if (input.runId)
    query = query.where('test_executions.test_run_id', '=', input.runId)

  if (input.testId)
    query = query.where('test_executions.managed_test_id', '=', input.testId)

  if (input.after)
    query = query.where('test_executions.id', '<', input.after)

  const rows = await query.orderBy('test_executions.id', 'desc').limit(input.limit).execute().catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    run: Number(row.test_run_id),
    test: Number(row.managed_test_id),
    name: String(row.name ?? ''),
    scope: String(row.scope ?? ''),
    result: String(row.result ?? ''),
    duration_ms: Number(row.duration_ms ?? 0),
    retries: Number(row.retries ?? 0),
    /*
     * The message and not the stack. A stack is the larger half of an
     * execution row and the half a dashboard never renders; the endpoint that
     * wants it can ask for the one execution rather than paying for it on
     * every page of a listing.
     */
    failure_message: row.failure_message ? String(row.failure_message) : null,
    workflow_job_id: row.workflow_job_id ? Number(row.workflow_job_id) : null,
    branch: String(row.branch ?? ''),
    head_sha: String(row.head_sha ?? ''),
  })) as any
}

/** What this instance currently believes about each test. */
async function states(input: {
  repositoryId: number
  suiteId: number | null
  state: string
  limit: number
  after: number | null
}): Promise<Array<Record<string, unknown>> & Array<{ id: number }>> {
  let query = db
    .selectFrom('managed_tests')
    .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
    .select([
      'managed_tests.id as id',
      'managed_tests.name as name',
      'managed_tests.scope as scope',
      'managed_tests.state as state',
      'managed_tests.flaky as flaky',
      'managed_tests.flaky_reason as flaky_reason',
      'managed_tests.flaky_since as flaky_since',
      'managed_tests.muted_reason as muted_reason',
      'managed_tests.muted_at as muted_at',
      'managed_tests.review_at as review_at',
      'managed_tests.owner as owner',
      'test_suites.slug as suite',
    ])
    .where('test_suites.repository_id', '=', input.repositoryId)

  if (input.suiteId)
    query = query.where('managed_tests.test_suite_id', '=', input.suiteId)

  if (input.state === 'flaky')
    query = query.where('managed_tests.flaky', '=', true)
  else if (input.state)
    query = query.where('managed_tests.state', '=', input.state)

  if (input.after)
    query = query.where('managed_tests.id', '<', input.after)

  const rows = await query.orderBy('managed_tests.id', 'desc').limit(input.limit).execute().catch(() => [])
  const now = Date.now()

  return rows.map(row => ({
    id: Number(row.id),
    suite: String(row.suite ?? ''),
    name: String(row.name ?? ''),
    scope: String(row.scope ?? ''),
    state: String(row.state ?? ''),
    flaky: Boolean(row.flaky),
    flaky_reason: row.flaky_reason ? String(row.flaky_reason) : null,
    flaky_since: row.flaky_since ? String(row.flaky_since) : null,
    muted_reason: row.muted_reason ? String(row.muted_reason) : null,
    muted_at: row.muted_at ? String(row.muted_at) : null,
    review_at: row.review_at ? String(row.review_at) : null,
    /*
     * Said outright rather than left to the caller's date arithmetic. A
     * quarantine whose review date has passed is the one thing a listing of
     * muted tests exists to surface - it is what stops a quarantine becoming a
     * graveyard - and a client that has to compute it is a client that will
     * not.
     */
    review_overdue: Boolean(row.review_at && Date.parse(String(row.review_at)) < now),
    owner: row.owner ? String(row.owner) : null,
  })) as any
}
