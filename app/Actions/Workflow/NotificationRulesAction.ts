import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { globMatches } from './notifyRules'

/**
 * Who hears about this repository's runs, and when.
 *
 * A rule set rather than a switch, which is the whole of the box this
 * implements. "Notify me about this repository" is an inbox nobody reads by the
 * second week: twelve workflows on every push produce twelve messages about
 * things that were always going to pass. The rules people want are narrow -
 * *the deploy workflow, failing, on main* - and each of those is one row.
 *
 * **A rule names somebody on this instance.** The channel is theirs to choose:
 * phase 5 already knows whether they want an email, a push, or only the inbox,
 * and a rule that took an address would make this a mail relay with a spam
 * problem.
 *
 * Adding a rule for *yourself* needs read access, because it is a subscription.
 * Adding one for somebody else needs `repository:settings`: signing a colleague
 * up for an alert is a thing a repository administrator may do and a passer-by
 * may not.
 */
export default new Action({
  name: 'WorkflowNotifications',
  description: 'Rules deciding who is told when a run ends',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'add', 'remove']) },
    user: { rule: schema.string(), required: false },
    workflow: { rule: schema.string(), required: false },
    branch: { rule: schema.string(), required: false },
    job: { rule: schema.string(), required: false },
    condition: { rule: schema.enum(['failure', 'success', 'recovery', 'always']), required: false },
    id: { rule: schema.number(), required: false },
  },

  responses: {
    200: { description: 'The rules this repository now has.' },
    ...REPOSITORY_ERRORS,
    422: { description: 'The rule is missing something, or names a condition this instance does not have.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'list').trim() || 'list'
    const handle = String(request.get('user') ?? '').trim().toLowerCase()

    /*
     * The gate depends on who the rule is about, so the ability is decided
     * before the repository is loaded: a subscription for yourself is reading,
     * and a subscription for somebody else is administration.
     */
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const repositoryId = Number(repository.id)

    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    if (operation === 'list')
      return response.json({ rules: await listRules(repositoryId) })

    const forSomebodyElse = Boolean(handle) && handle !== String(user.handle).toLowerCase()

    if (forSomebodyElse && !auth.context.can('repository:settings')) {
      return response.json({
        error: 'Only somebody who administers this repository may add a rule for another person',
        reason: 'A rule for yourself needs no more than being able to read the repository.',
      }, 403)
    }

    const subject = forSomebodyElse
      ? await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()
      : { id: user.id }

    if (!subject)
      return response.json({ error: 'No such person' }, 404)

    if (operation === 'remove') {
      const id = Number(request.get('id'))

      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which rule?' }, 422)

      /*
       * Scoped to the repository *and* to whoever may remove it: a person may
       * always drop their own rule, and an administrator may drop anybody's.
       * Without the second clause, unsubscribing somebody who has left is
       * something nobody can do.
       */
      let query = db
        .deleteFrom('workflow_notification_rules')
        .where('id', '=', id)
        .where('repository_id', '=', repositoryId)

      if (!auth.context.can('repository:settings'))
        query = query.where('user_id', '=', Number(user.id))

      await query.execute()

      return response.json({ rules: await listRules(repositoryId) })
    }

    const workflow = String(request.get('workflow') ?? '*').trim() || '*'
    const branch = String(request.get('branch') ?? '*').trim() || '*'
    const job = String(request.get('job') ?? '').trim()
    const condition = String(request.get('condition') ?? 'failure').trim()

    if (!['failure', 'success', 'recovery', 'always'].includes(condition)) {
      return response.json({
        error: 'That is not a condition this instance has',
        reason: '`failure`, `success`, `recovery` - the first success after a failure - or `always`.',
      }, 422)
    }

    /*
     * A rule that can never match is refused rather than stored. A workflow
     * name with a typo in it is the commonest way an alert silently never
     * arrives, and the moment to catch it is while somebody is looking at it.
     */
    if (workflow !== '*') {
      const workflows = await db
        .selectFrom('workflows')
        .select(['name', 'path'])
        .where('repository_id', '=', repositoryId)
        .execute()
        .catch(() => [])

      const matches = workflows.some(one =>
        globMatches(workflow, String(one.path))
        || globMatches(workflow, String(one.name))
        || globMatches(workflow, String(one.path).split('/').pop() ?? ''))

      if (!matches) {
        return response.json({
          error: `No workflow in this repository matches \`${workflow}\``,
          reason: 'Name it by path, by file name, or by the workflow\'s own name - or use `*` for every workflow.',
          workflows: workflows.map(one => String(one.path)),
        }, 422)
      }
    }

    const existing = await db
      .selectFrom('workflow_notification_rules')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', Number(subject.id))
      .where('workflow', '=', workflow)
      .where('branch', '=', branch)
      .where('job_key', '=', job)
      .where('condition', '=', condition)
      .executeTakeFirst()

    // Adding the same rule twice is somebody pressing a button twice, not an
    // error - and two rows would be two notifications about one run.
    if (!existing) {
      await db.insertInto('workflow_notification_rules').values({
        repository_id: repositoryId,
        user_id: Number(subject.id),
        workflow,
        branch,
        job_key: job,
        condition,
        created_by_id: Number(user.id),
      }).execute()
    }

    return response.json({ rules: await listRules(repositoryId) })
  },
})

/** Every rule, with the handle rather than the id: a list of numbers is a list nobody prunes. */
async function listRules(repositoryId: number): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .selectFrom('workflow_notification_rules')
    .innerJoin('users', 'users.id', '=', 'workflow_notification_rules.user_id')
    .select([
      'workflow_notification_rules.id as id',
      'workflow_notification_rules.workflow as workflow',
      'workflow_notification_rules.branch as branch',
      'workflow_notification_rules.job_key as job_key',
      'workflow_notification_rules.condition as condition',
      'users.handle as handle',
    ])
    .where('workflow_notification_rules.repository_id', '=', repositoryId)
    .orderBy('workflow_notification_rules.id')
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    user: String(row.handle),
    workflow: String(row.workflow ?? '*'),
    branch: String(row.branch ?? '*'),
    job: String(row.job_key ?? ''),
    condition: String(row.condition ?? 'failure'),
  }))
}
