import { Action } from '@stacksjs/actions'
import { canOnRepository } from '../../Permissions'
import { permissionOn } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'

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

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:assign')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

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

    await db.deleteFrom('issue_assignees').where('issue_id', '=', Number(issue.id)).execute()

    if (users.length > 0) {
      await db
        .insertInto('issue_assignees')
        .values(users.map((row: any) => ({ issue_id: Number(issue.id), user_id: Number(row.id) })))
        .execute()
    }

    return response.json({ number, assignees: users.map((row: any) => row.handle) })
  },
})
