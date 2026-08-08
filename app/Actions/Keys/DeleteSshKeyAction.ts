import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'

/**
 * Remove an SSH key.
 *
 * Scoped to the caller in the `where`, not checked and then deleted: one
 * statement that can only ever match a row the caller owns has no window
 * between the check and the delete, and cannot be got wrong by a later edit.
 *
 * A key that is not there answers the same as one that was just removed. The
 * alternative tells whoever is guessing ids which ones exist.
 */
export default new Action({
  name: 'DeleteSshKey',
  description: 'Remove one of the caller\'s SSH keys',
  // The verb this action is about. `routes/api.ts` also registers it on POST,
  // because an HTML form can only send GET or POST and every write in this
  // application goes through a form with a CSRF field.
  method: 'DELETE',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const id = Number(request.get('id') ?? 0)
    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'Which key?' }, 422)

    await db
      .deleteFrom('ssh_keys')
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .execute()

    return response.json({ ok: true })
  },
})
