import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'

/**
 * Remove a GPG key.
 *
 * Scoped to the caller in the `where`, not checked and then deleted: one
 * statement that can only ever match a row the caller owns has no window
 * between the check and the delete, and cannot be got wrong by a later edit.
 *
 * A key that is not there answers the same as one that was just removed. The
 * alternative tells whoever is guessing ids which ones exist.
 */
export default new Action({
  name: 'DeleteGpgKey',
  description: 'Remove one of the caller\'s GPG keys',
  // The verb this action is about. `routes/api.ts` also registers it on POST,
  // because an HTML form can only send GET or POST and every write in this
  // application goes through a form with a CSRF field.
  method: 'DELETE',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const id = Number(request.get('id') ?? 0)
    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'Which key?' }, 422)

    // Read for the record, deleted by the same scoped statement as before. See
    // the note in `DeleteSshKeyAction`: afterwards there is no fingerprint left
    // to name.
    const key = await db
      .selectFrom('gpg_keys')
      .select(['id', 'key_id'])
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    await db
      .deleteFrom('gpg_keys')
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .execute()

    if (key) {
      await auditEvent('key:removed', {
        subject: { type: 'gpg_key', id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { kind: 'gpg', fingerprint: String(key.key_id ?? '') },
      })
    }

    return response.json({ ok: true })
  },
})
