import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { milestoneFields } from './labelSet'

/**
 * Create, edit, close, reopen or delete a milestone.
 *
 * Titles are unique per repository for the same reason label names are: a
 * milestone is picked from a list by its title, and two called "1.0" is a
 * choice nobody can make correctly.
 *
 * Deleting empties the milestone rather than deleting its issues. That is the
 * only defensible reading of "delete the milestone", and it is worth saying out
 * loud because the opposite is one `ON DELETE CASCADE` away.
 */
export default new Action({
  name: 'ManageMilestone',
  description: 'Create, update, close or delete a milestone',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    description: { rule: schema.string() },
    due_on: { rule: schema.string() },
    id: { rule: schema.number() },
    operation: { rule: schema.string() },
    title: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'milestone:manage')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const operation = String(request.get('operation') ?? 'create').toLowerCase()

    if (operation === 'delete')
      return remove(request, repository)

    if (operation === 'close' || operation === 'reopen')
      return setState(request, repository, operation === 'close' ? 'closed' : 'open')

    const fields = milestoneFields({
      title: request.get('title'),
      description: request.get('description'),
      due_on: request.get('due_on'),
    })

    if (!fields.ok)
      return response.json({ error: fields.error }, 422)

    const existing = await db
      .selectFrom('milestones')
      .select(['id', 'title'])
      .where('repository_id', '=', repository.id)
      .execute()

    const collides = (row: { title: unknown }) => String(row.title).toLowerCase() === fields.value.title.toLowerCase()

    if (operation === 'update') {
      const id = Number(request.get('id'))
      if (!existing.some(row => Number(row.id) === id))
        return response.json({ error: 'No such milestone' }, 404)

      if (existing.some(row => Number(row.id) !== id && collides(row)))
        return response.json({ error: 'A milestone with that title already exists' }, 409)

      await db.updateTable('milestones').set(fields.value).where('id', '=', id).execute()

      return response.json({ id, ...fields.value })
    }

    if (existing.some(collides))
      return response.json({ error: 'A milestone with that title already exists' }, 409)

    const created = await db
      .insertInto('milestones')
      .values({
        repository_id: repository.id,
        ...fields.value,
        state: 'open',
      })
      .returning(['id'])
      .executeTakeFirst()

    return response.json({ id: Number(created?.id), ...fields.value, state: 'open' }, 201)
  },
})

async function setState(request: any, repository: any, state: 'open' | 'closed') {
  const id = Number(request.get('id'))

  const milestone = await db
    .selectFrom('milestones')
    .select(['id', 'state'])
    .where('id', '=', id)
    .where('repository_id', '=', repository.id)
    .executeTakeFirst()

  if (!milestone)
    return response.json({ error: 'No such milestone' }, 404)

  // Already there is success, not an error: two people closing the same
  // milestone should not produce a failure for the slower one.
  if (String(milestone.state) === state)
    return response.json({ id, state })

  await db.updateTable('milestones').set({ state }).where('id', '=', id).execute()

  return response.json({ id, state })
}

async function remove(request: any, repository: any) {
  const id = Number(request.get('id'))

  const milestone = await db
    .selectFrom('milestones')
    .select(['id'])
    .where('id', '=', id)
    .where('repository_id', '=', repository.id)
    .executeTakeFirst()

  if (!milestone)
    return response.json({ error: 'No such milestone' }, 404)

  // The issues survive; they just stop being in a milestone.
  await db.updateTable('issues').set({ milestone_id: null }).where('milestone_id', '=', id).execute()
  await db.deleteFrom('milestones').where('id', '=', id).execute()

  return response.json({ deleted: id })
}
