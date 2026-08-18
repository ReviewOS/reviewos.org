import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { recordMany } from './timeline'

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
    // An array of label names, as the handler reads it.
    labels: { rule: schema.array() },
  },

  responses: {
    200: { description: 'The labels as they now stand.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Labelling needs write access to the repository.' },
    404: { description: 'No such repository or issue, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:label')
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

    // What was there before, so the timeline can say what actually changed
    // rather than restating the whole set on every save.
    const before = await db
      .selectFrom('issue_labels')
      .innerJoin('repository_labels', 'repository_labels.id', '=', 'issue_labels.label_id')
      .select(['repository_labels.name as name'])
      .where('issue_labels.issue_id', '=', Number(issue.id))
      .execute()

    await db.deleteFrom('issue_labels').where('issue_id', '=', Number(issue.id)).execute()

    if (labels.length > 0) {
      await db
        .insertInto('issue_labels')
        .values(labels.map((label: any) => ({ issue_id: Number(issue.id), label_id: Number(label.id) })))
        .execute()
    }

    const had = new Set<string>(before.map(row => String(row.name)))
    const now = new Set<string>(labels.map((label: any) => String(label.name)))
    const subject = { type: 'issue' as const, id: Number(issue.id) }
    const actorId = user ? Number(user.id) : null

    await recordMany([
      ...[...now].filter(name => !had.has(name)).map(name => ({ subject, kind: 'labeled' as const, actorId, detail: { text: String(name) } })),
      ...[...had].filter(name => !now.has(name)).map(name => ({ subject, kind: 'unlabeled' as const, actorId, detail: { text: String(name) } })),
    ])

    return response.json({ number, labels: labels.map((label: any) => label.name) })
  },
})
