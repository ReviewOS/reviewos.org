import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Muting, skipping, owning, and looking at a test's history.
 *
 * **Quarantine is the feature, and it expires.** A mute with nobody's name on
 * it, no reason, and no review date is permanent: nobody remembers who did it
 * or whether the reason still holds, and the suite quietly stops testing what
 * it says it tests. So all four are recorded, and a listing surfaces the ones
 * whose review date has passed - which is what stops a quarantine becoming a
 * graveyard.
 *
 * **Muted and skipped are different states**, and most tools conflate them. A
 * muted test still runs and still reports; its failures are counted, kept in
 * its history, and simply not counted against the run. So the day it starts
 * passing again is visible, and somebody can tell whether the mute is still
 * needed. A skipped test does not run, so nobody learns anything about it.
 */
export default new Action({
  name: 'ManageTest',
  description: 'Mute, skip, own, or inspect a test',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'flaky', 'quarantined', 'mute', 'skip', 'enable', 'own', 'history']) },
    suite: { rule: schema.string() },
    test: { rule: schema.number() },
    reason: { rule: schema.string() },
    review: { rule: schema.string() },
    who: { rule: schema.string() },
    limit: { rule: schema.number() },
  },

  responses: {
    200: { description: 'The tests, or the one that changed.' },
    ...REPOSITORY_ERRORS,
    /*
     * After the shared set, deliberately: a test in another repository is
     * *not found* rather than refused, because its existence is not this
     * caller's to learn - and that is a narrower meaning than the shared 404.
     */
    404: { description: 'No such test in this repository, or none this caller may see.' },
    422: { description: 'A mute needs a reason and a review date.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Reading is read access; changing a test's state is write.
     *
     * Muting a test is a decision about what the suite tests, which is a
     * change to the repository even though no file moved - and it is exactly
     * the change somebody would want to make quietly.
     */
    const auth = await authorizeRepository(request, ['list', 'flaky', 'quarantined', 'history'].includes(operation) ? 'repository:read' : 'check:report')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const limit = Math.min(500, Math.max(1, Number(request.get('limit')) || 100))

    if (['list', 'flaky', 'quarantined'].includes(operation)) {
      let query = db
        .selectFrom('managed_tests')
        .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
        .select([
          'managed_tests.id as id',
          'managed_tests.scope as scope',
          'managed_tests.name as name',
          'managed_tests.state as state',
          'managed_tests.owner as owner',
          'managed_tests.flaky as flaky',
          'managed_tests.flaky_reason as flaky_reason',
          'managed_tests.muted_at as muted_at',
          'managed_tests.muted_reason as muted_reason',
          'managed_tests.review_at as review_at',
          'test_suites.slug as suite',
        ])
        .where('test_suites.repository_id', '=', Number(repository.id))

      const suite = String(request.get('suite') ?? '').trim()

      if (suite)
        query = query.where('test_suites.slug', '=', suite)

      if (operation === 'flaky')
        query = query.where('managed_tests.flaky', '=', true)

      if (operation === 'quarantined')
        query = query.where('managed_tests.state', 'in', ['muted', 'skipped'])

      const rows: any[] = await query.orderBy('managed_tests.id', 'desc').limit(limit).execute()
      const now = new Date().toISOString()

      return response.json({
        tests: rows.map(row => ({
          id: Number(row.id),
          suite: String(row.suite),
          scope: String(row.scope ?? ''),
          name: String(row.name),
          state: String(row.state),
          owner: row.owner ? String(row.owner) : null,
          flaky: row.flaky === true,
          flaky_reason: row.flaky_reason ? String(row.flaky_reason) : null,
          muted_at: row.muted_at ? String(row.muted_at) : null,
          muted_reason: row.muted_reason ? String(row.muted_reason) : null,
          review_at: row.review_at ? String(row.review_at) : null,
          /*
           * The field that keeps a quarantine from becoming a graveyard: a
           * mute whose review date has passed, surfaced without anybody having
           * to run a query they would never think to run.
           */
          overdue: Boolean(row.review_at) && String(row.review_at) < now,
        })),
      })
    }

    const testId = Number(request.get('test'))

    if (!Number.isInteger(testId) || testId <= 0)
      return response.json({ error: 'Which test?' }, 422)

    const test: any = await db
      .selectFrom('managed_tests')
      .innerJoin('test_suites', 'test_suites.id', '=', 'managed_tests.test_suite_id')
      .select(['managed_tests.id as id', 'managed_tests.name as name', 'test_suites.repository_id as repository_id'])
      .where('managed_tests.id', '=', testId)
      .executeTakeFirst()

    // A test in somebody else's repository is not found, rather than refused:
    // its existence is not this caller's to learn.
    if (!test || Number(test.repository_id) !== Number(repository.id))
      return response.json({ error: 'No such test' }, 404)

    if (operation === 'history') {
      const rows: any[] = await db
        .selectFrom('test_executions')
        .innerJoin('test_runs', 'test_runs.id', '=', 'test_executions.test_run_id')
        .select([
          'test_executions.result as result',
          'test_executions.duration_ms as duration_ms',
          'test_executions.retries as retries',
          'test_executions.failure_message as failure_message',
          'test_runs.head_sha as head_sha',
          'test_runs.branch as branch',
          'test_runs.created_at as at',
        ])
        .where('test_executions.managed_test_id', '=', testId)
        .orderBy('test_executions.id', 'desc')
        .limit(limit)
        .execute()

      return response.json({
        test: { id: testId, name: String(test.name) },
        executions: rows.map(row => ({
          result: String(row.result),
          duration_ms: Number(row.duration_ms ?? 0),
          retries: Number(row.retries ?? 0),
          failure_message: row.failure_message ? String(row.failure_message) : null,
          head_sha: String(row.head_sha),
          branch: row.branch ? String(row.branch) : null,
          at: row.at ? String(row.at) : null,
        })),
      })
    }

    if (operation === 'own') {
      const owner = String(request.get('who') ?? '').trim().slice(0, 200)

      await db.updateTable('managed_tests').set({ owner: owner || null } as any).where('id', '=', testId).execute()

      return response.json({ test: { id: testId, owner: owner || null } })
    }

    if (operation === 'enable') {
      await db
        .updateTable('managed_tests')
        .set({ state: 'enabled', muted_by_id: null, muted_at: null, muted_reason: null, review_at: null } as any)
        .where('id', '=', testId)
        .execute()

      return response.json({ test: { id: testId, state: 'enabled' } })
    }

    const reason = String(request.get('reason') ?? '').trim()
    const review = String(request.get('review') ?? '').trim()

    /*
     * Both required, and this is the whole design of quarantine here.
     *
     * A mute without a reason is one nobody can evaluate later, and a mute
     * without a review date is one nobody will look at again. Refusing is
     * friction on purpose: the friction is what keeps the suite honest, and it
     * is thirty seconds against a test that would otherwise be off forever.
     */
    if (!reason)
      return response.json({ error: 'A mute needs a reason', reason: 'Somebody will read this in three months and need to know whether it still holds.' }, 422)

    if (!review)
      return response.json({ error: 'A mute needs a review date', reason: 'Without one, quarantine is a graveyard. An ISO date is fine.' }, 422)

    const now = new Date().toISOString()

    await db
      .updateTable('managed_tests')
      .set({
        state: operation === 'skip' ? 'skipped' : 'muted',
        muted_by_id: auth.context.user?.id ?? null,
        muted_at: now,
        muted_reason: reason.slice(0, 1000),
        review_at: review.slice(0, 40),
      } as any)
      .where('id', '=', testId)
      .execute()

    return response.json({
      test: {
        id: testId,
        state: operation === 'skip' ? 'skipped' : 'muted',
        muted_reason: reason,
        review_at: review,
      },
      /*
       * Said back, because the difference is the one people get wrong: a muted
       * test still runs and still reports, and a skipped one does not run at
       * all.
       */
      note: operation === 'skip'
        ? 'This test will not run. Nothing will be learned about it until it is enabled again.'
        : 'This test still runs and still reports. Its failures no longer count against a run.',
    })
  },
})
