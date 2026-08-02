import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { labelFields } from './labelSet'
import { labelNamesCollide } from './labels'

/**
 * Create, rename, recolour or delete one of a repository's labels.
 *
 * One action rather than three, because the interesting rule is shared: a
 * repository may not end up with two labels whose names collide, and "collide"
 * is more than "are equal" - `Bug` and `bug` are the same label to everyone
 * except a unique index.
 *
 * Deleting is the reason this needs write rather than triage. The label
 * disappears from every issue that carried it, and those rows are not coming
 * back.
 */
export default new Action({
  name: 'ManageLabel',
  description: 'Create, update or delete a repository label',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'label:manage')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const operation = String(request.get('operation') ?? 'create').toLowerCase()

    if (operation === 'delete')
      return remove(request, repository)

    const fields = labelFields({
      name: request.get('name'),
      color: request.get('color'),
      description: request.get('description'),
    })

    if (!fields.ok)
      return response.json({ error: fields.error }, 422)

    const existing: any[] = await db
      .selectFrom('repository_labels')
      .select(['id', 'name'])
      .where('repository_id', '=', repository.id)
      .execute()

    if (operation === 'update') {
      const id = Number(request.get('id'))
      const target = existing.find(row => Number(row.id) === id)
      if (!target)
        return response.json({ error: 'No such label' }, 404)

      // Its own name is not a collision, or a label could never be recoloured.
      const clash = existing.some(row => Number(row.id) !== id && labelNamesCollide(String(row.name), fields.value.name))
      if (clash)
        return response.json({ error: 'A label with that name already exists' }, 409)

      await db
        .updateTable('repository_labels')
        .set({ name: fields.value.name, color: fields.value.color, description: fields.value.description })
        .where('id', '=', id)
        .execute()

      return response.json({ id, ...fields.value })
    }

    if (existing.some(row => labelNamesCollide(String(row.name), fields.value.name)))
      return response.json({ error: 'A label with that name already exists' }, 409)

    const created = await db
      .insertInto('repository_labels')
      .values({
        repository_id: repository.id,
        name: fields.value.name,
        color: fields.value.color,
        description: fields.value.description,
        is_default: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    return response.json({ id: Number(created?.id), ...fields.value }, 201)
  },
})

/**
 * Delete a label, and detach it from the issues carrying it.
 *
 * The join rows go first. Leaving them for a cascade means depending on a
 * constraint the migration generator has not always produced, and an orphaned
 * `issue_labels` row shows an issue as labelled with nothing.
 */
async function remove(request: any, repository: any) {
  const id = Number(request.get('id'))

  const label = await db
    .selectFrom('repository_labels')
    .select(['id'])
    .where('id', '=', id)
    .where('repository_id', '=', repository.id)
    .executeTakeFirst()

  if (!label)
    return response.json({ error: 'No such label' }, 404)

  await db.deleteFrom('issue_labels').where('label_id', '=', id).execute()
  await db.deleteFrom('repository_labels').where('id', '=', id).execute()

  return response.json({ deleted: id })
}
