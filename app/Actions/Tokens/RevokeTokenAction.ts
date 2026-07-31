import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'

/**
 * Revoke a token.
 *
 * The row is kept with `revoked_at` set rather than deleted, so the audit trail
 * survives: "which token did this, and when was it stopped" is a question asked
 * after something has gone wrong, and a deleted row answers it with silence.
 *
 * Revocation takes effect on the very next request, because `authenticate.ts`
 * reads this state per request and there is nothing cached in front of it.
 */
export default new Action({
  name: 'RevokeAccessToken',
  description: 'Revoke an access token',
  method: 'DELETE',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const id = Number(request.get('id'))
    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'A token id is required' }, 422)

    const token = await db
      .selectFrom('access_tokens')
      .select(['id', 'user_id', 'revoked_at'])
      .where('id', '=', id)
      .executeTakeFirst()

    // A token belonging to somebody else is reported as missing rather than
    // forbidden, for the same reason a private repository is: the alternative
    // confirms that a given id exists.
    if (!token || Number(token.user_id) !== user.id)
      return response.json({ error: 'No such token' }, 404)

    if (token.revoked_at)
      return response.json({ id, revoked_at: token.revoked_at, already_revoked: true })

    const revokedAt = new Date().toISOString()

    await db
      .updateTable('access_tokens')
      .set({ revoked_at: revokedAt, revoked_by_id: user.id })
      .where('id', '=', id)
      .execute()

    return response.json({ id, revoked_at: revokedAt, already_revoked: false })
  },
})
