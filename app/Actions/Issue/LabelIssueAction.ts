import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Set the labels on an issue.
 *
 * The whole set is replaced rather than added to, so a client that shows the
 * label picker and sends what the user chose does not need to work out which
 * labels were removed.
 */
export default new Action({
  name: 'LabelIssue',
  description: 'Replace the labels on an issue',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:label')
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

    const requested = request.get('labels')
    const names: string[] = Array.isArray(requested) ? requested.map(String) : []

    // Only labels belonging to this repository, so a label id from elsewhere
    // cannot be attached and leak another repository's vocabulary.
    const labels = names.length === 0
      ? []
      : await db
          .selectFrom('repository_labels')
          .select(['id', 'name'])
          .where('repository_id', '=', repository.id)
          .where('name', 'in', names)
          .execute()

    const unknown = names.filter(name => !labels.some((label: any) => label.name === name))
    if (unknown.length > 0)
      return response.json({ error: `No such label: ${unknown.join(', ')}` }, 422)

    await db.deleteFrom('issue_labels').where('issue_id', '=', Number(issue.id)).execute()

    if (labels.length > 0) {
      await db
        .insertInto('issue_labels')
        .values(labels.map((label: any) => ({ issue_id: Number(issue.id), label_id: Number(label.id) })))
        .execute()
    }

    return response.json({ number, labels: labels.map((label: any) => label.name) })
  },
})
