import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { canOnRepository } from '../../Permissions'
import { permissionOn } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { recordMany } from './timeline'

/**
 * Set who is working on an issue.
 *
 * The whole set is replaced rather than added to, the same way labels are: a
 * client that shows a picker and sends what the user chose should not have to
 * work out which assignees were removed.
 *
 * An assignee has to be able to see the repository. Assigning a stranger to a
 * private issue would put it in their list and tell them it exists.
 */
export default new Action({
  name: 'AssignIssue',
  description: 'Replace the assignees on an issue',
  method: 'PUT',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. `owner` plus one of `repo` or `repository` addresses
   * every repository-scoped endpoint - see `authorizeRepository` - and a caller
   * who forgets one should be told which field is missing rather than shown a
   * 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    number: { rule: schema.number().required() },
    // An array of handles, which is what the handler reads and what every
    // client sends. A string rule here refused the ordinary request.
    assignees: { rule: schema.array() },
  },

  responses: {
    200: { description: 'The assignees as they now stand.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Assigning somebody needs write access to the repository.' },
    404: { description: 'No such repository or issue, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:assign')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    const requested = request.get('assignees')
    const handles: string[] = Array.isArray(requested)
      ? [...new Set(requested.map((handle: unknown) => String(handle).trim().toLowerCase()).filter(Boolean))]
      : []

    if (handles.length > 10)
      return response.json({ error: 'An issue takes at most ten assignees' }, 422)

    const users = handles.length === 0
      ? []
      : await db.selectFrom('users').select(['id', 'handle']).where('handle', 'in', handles).execute()

    const unknown = handles.filter(handle => !users.some((row: any) => String(row.handle).toLowerCase() === handle))
    if (unknown.length > 0)
      return response.json({ error: `No such user: ${unknown.join(', ')}` }, 422)

    // Checked through the same rule the request itself went through, rather
    // than a second reading of visibility here. Two answers to "can this person
    // see this repository" is how they come to disagree.
    for (const row of users) {
      const grants = await permissionOn(repository, Number(row.id))
      const visible = canOnRepository({
        userId: Number(row.id),
        visibility: repository.visibility,
        ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
        ...grants,
      }, 'repository:read')

      if (!visible)
        return response.json({ error: `${row.handle} cannot see this repository` }, 422)
    }

    // Read before the delete, so the timeline records the difference rather
    // than restating the whole set every time somebody saves.
    const before = await db
      .selectFrom('issue_assignees')
      .innerJoin('users', 'users.id', '=', 'issue_assignees.user_id')
      .select(['users.handle as handle'])
      .where('issue_assignees.issue_id', '=', Number(issue.id))
      .execute()

    await db.deleteFrom('issue_assignees').where('issue_id', '=', Number(issue.id)).execute()

    if (users.length > 0) {
      await db
        .insertInto('issue_assignees')
        .values(users.map((row: any) => ({ issue_id: Number(issue.id), user_id: Number(row.id) })))
        .execute()
    }

    const had = new Set<string>(before.map(row => String(row.handle)))
    const now = new Set<string>(users.map((row: any) => String(row.handle)))
    const subject = { type: 'issue' as const, id: Number(issue.id) }
    const actorId = user ? Number(user.id) : null

    await recordMany([
      ...[...now].filter(handle => !had.has(handle)).map(handle => ({ subject, kind: 'assigned' as const, actorId, detail: { text: handle } })),
      ...[...had].filter(handle => !now.has(handle)).map(handle => ({ subject, kind: 'unassigned' as const, actorId, detail: { text: handle } })),
    ])

    return response.json({ number, assignees: users.map((row: any) => row.handle) })
  },
})
