import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { CONDITIONS, evaluateMonitors } from './monitors'

/**
 * The rules that watch a suite: listing them, writing one, and asking for an
 * evaluation now rather than at the top of the hour.
 *
 * **A monitor fires on the transition and nothing else**, which is what makes
 * it worth having rather than a saved query somebody could run themselves. That
 * behaviour lives in `monitors.ts` next to the state it depends on; this is the
 * credential and the shape.
 *
 * Three conditions, deliberately, and no expression language. A general one
 * would be a second product to document, test, and get wrong - and the three
 * here are the questions people actually ask about a suite: how much of it is
 * unreliable, how much of it fails, and how long it takes.
 */
export default new Action({
  name: 'MonitorTests',
  description: 'Create, list, or evaluate the rules that watch a test suite',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'create', 'update', 'delete', 'evaluate']) },
    monitor: { rule: schema.number() },
    suite: { rule: schema.string() },
    condition: { rule: schema.enum(['flaky', 'fail_rate', 'duration']) },
    threshold: { rule: schema.number() },
    window_days: { rule: schema.number() },
    enabled: { rule: schema.boolean() },
  },

  responses: {
    200: { description: 'The monitors, or the one that changed, or what an evaluation found.' },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such monitor in this repository.' },
    422: { description: 'A threshold that means nothing for the chosen condition.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Reading is read; writing a rule is write. A monitor decides what gets
     * announced to whatever is listening, so creating one is a change to the
     * repository even though no file moved.
     */
    const auth = await authorizeRepository(request, operation === 'list' ? 'repository:read' : 'check:report')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)

    if (operation === 'list') {
      const rows = await db
        .selectFrom('test_monitors')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .orderBy('id', 'desc')
        .limit(200)
        .execute()

      return response.json({ monitors: rows.map(shape) })
    }

    if (operation === 'evaluate') {
      // Asking now rather than waiting for the hour, which is what somebody
      // wants the moment after they write a rule and want to know it works.
      const outcome = await evaluateMonitors(repositoryId)

      return response.json(outcome)
    }

    if (operation === 'create') {
      const condition = String(request.get('condition') ?? 'fail_rate')
      const threshold = Number(request.get('threshold'))

      if (!(condition in CONDITIONS))
        return response.json({ error: 'Unknown condition', allowed: Object.keys(CONDITIONS) }, 422)

      if (!Number.isFinite(threshold) || threshold < 0)
        return response.json({ error: 'A monitor needs a threshold', reason: thresholdHelp(condition) }, 422)

      /*
       * A percentage above a hundred can never be crossed, and a monitor that
       * can never fire is worse than none: it reads as covered.
       */
      if (condition === 'fail_rate' && threshold > 100)
        return response.json({ error: 'A failure rate is a percentage', reason: 'between 0 and 100 - `5` is five percent of executions failing' }, 422)

      const created = await db
        .insertInto('test_monitors')
        .values({
          repository_id: repositoryId,
          suite: String(request.get('suite') ?? '').trim().slice(0, 200),
          condition,
          threshold,
          window_days: Math.max(1, Math.min(365, Number(request.get('window_days')) || 7)),
          state: 'ok',
          enabled: true,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      const row = await db.selectFrom('test_monitors').selectAll().where('id', '=', Number(created?.id)).executeTakeFirst()

      return response.json({ monitor: shape(row) })
    }

    const id = Number(request.get('monitor'))

    const existing = await db
      .selectFrom('test_monitors')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    // Somebody else's monitor is not found rather than refused: its existence
    // is not this caller's to learn.
    if (!existing || Number(existing.repository_id) !== repositoryId)
      return response.json({ error: 'No such monitor' }, 404)

    if (operation === 'delete') {
      await db.deleteFrom('test_monitors').where('id', '=', id).execute()

      return response.json({ deleted: id })
    }

    const changes: Record<string, unknown> = {}

    if (request.get('threshold') !== undefined && Number.isFinite(Number(request.get('threshold'))))
      changes.threshold = Number(request.get('threshold'))

    if (request.get('window_days') !== undefined && Number(request.get('window_days')) > 0)
      changes.window_days = Math.min(365, Number(request.get('window_days')))

    if (request.get('enabled') !== undefined)
      changes.enabled = String(request.get('enabled')) !== 'false' && request.get('enabled') !== false

    if (!Object.keys(changes).length)
      return response.json({ error: 'Nothing to change' }, 422)

    await db.updateTable('test_monitors').set(changes as any).where('id', '=', id).execute()

    const row = await db.selectFrom('test_monitors').selectAll().where('id', '=', id).executeTakeFirst()

    return response.json({ monitor: shape(row) })
  },
})

/** What a threshold means, said where somebody got it wrong. */
function thresholdHelp(condition: string): string {
  if (condition === 'fail_rate')
    return 'a percentage between 0 and 100 - `5` is five percent of executions failing'

  if (condition === 'duration')
    return 'milliseconds, for what one run of the suite costs'

  return 'a count of tests that disagree with themselves'
}

function shape(row: any): Record<string, unknown> {
  return {
    id: Number(row.id),
    suite: row.suite ? String(row.suite) : null,
    condition: String(row.condition),
    threshold: Number(row.threshold ?? 0),
    window_days: Number(row.window_days ?? 7),
    state: String(row.state ?? 'ok'),
    measurement: Number(row.measurement ?? 0),
    enabled: row.enabled === true,
    /*
     * Both dates, because the difference is the question somebody has: a rule
     * that says everything is fine and a rule that has not run since March
     * look identical without `evaluated_at`.
     */
    changed_at: row.changed_at ? String(row.changed_at) : null,
    evaluated_at: row.evaluated_at ? String(row.evaluated_at) : null,
  }
}
