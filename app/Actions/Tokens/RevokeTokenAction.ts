import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { recordTokenAudit } from './audit'
import { organizationsReachedBy } from './organization'

/**
 * Revoke a token.
 *
 * The row is kept with `revoked_at` set rather than deleted, so the audit trail
 * survives: "which token did this, and when was it stopped" is a question asked
 * after something has gone wrong, and a deleted row answers it with silence.
 *
 * Revocation takes effect on the very next request, because `authenticate.ts`
 * reads this state per request and there is nothing cached in front of it.
 *
 * **An organization owner may revoke a token that reaches their repositories,
 * even though it is not theirs.** That is the point of the power: the case it
 * exists for is a contractor leaving, or a laptop lost, and in both the person
 * who can act quickly is not the person holding the token. The scope is exactly
 * what the token can reach - an owner of one organization cannot revoke a token
 * because it exists, only because it reaches them - and it is recorded with the
 * actor being somebody other than the owner, which is the one case in the audit
 * log where those differ.
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

    const token: any = await db
      .selectFrom('access_tokens')
      .select(['id', 'user_id', 'prefix', 'revoked_at'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!token)
      return response.json({ error: 'No such token' }, 404)

    const ownerId = Number(token.user_id)
    const mine = ownerId === user.id

    /*
     * Which of this owner's organizations the caller administers *and* the
     * token reaches. Both halves: administering an organization the token
     * cannot touch is not a reason, and a token reaching an organization the
     * caller does not administer is not their business.
     */
    const asAdministrator = mine ? [] : await organizationsReachedBy(Number(token.id), user.id)

    // A token belonging to somebody else, that reaches nothing the caller
    // administers, is reported as missing rather than forbidden - for the same
    // reason a private repository is: the alternative confirms a given id
    // exists, and token ids are small integers.
    if (!mine && asAdministrator.length === 0)
      return response.json({ error: 'No such token' }, 404)

    if (token.revoked_at)
      return response.json({ id, revoked_at: token.revoked_at, already_revoked: true })

    const revokedAt = new Date().toISOString()
    const reason = String(request.get('reason') ?? '').trim() || null

    await db
      .updateTable('access_tokens')
      .set({ revoked_at: revokedAt, revoked_by_id: user.id })
      .where('id', '=', id)
      .execute()

    await recordTokenAudit({
      event: 'token:revoked',
      tokenId: id,
      ownerId,
      prefix: token.prefix ? String(token.prefix) : null,
      actorId: user.id,
      reason,
      detail: {
        // The interesting distinction on this row, and the reason it is worth
        // reading months later: somebody's token being stopped by somebody else.
        by_owner: mine,
        ...(mine ? {} : { as_administrator_of: asAdministrator }),
      },
    })

    return response.json({
      id,
      revoked_at: revokedAt,
      already_revoked: false,
      ...(mine ? {} : { revoked_as_administrator: true }),
    })
  },
})
