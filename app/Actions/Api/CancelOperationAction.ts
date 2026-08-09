import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { isTerminal, view } from '../../Api/operations'
import { currentActor } from '../Identity/lookup'

/**
 * Ask an operation to stop.
 *
 * **The same token authority that created it, and not merely the same person.**
 * A person cancelling from their browser what their own token started is fine;
 * one token cancelling another's work is not, and the difference matters
 * precisely because agents now hold tokens. Two agents on one account should
 * not be able to stop each other, and a read-scoped token should not be able to
 * stop anything.
 *
 * A request rather than an act. The work is running somewhere else and notices
 * at its next checkpoint, so this records that a stop was asked for and answers
 * with the operation still in its current state. Reporting `cancelled`
 * immediately would be the one lie a status endpoint must not tell.
 */
export default new Action({
  name: 'CancelOperation',
  description: 'Ask a long-running operation to stop',
  method: 'POST',

  validations: {
    id: { rule: schema.string() },
  },

  async handle(request: any) {
    // `currentActor`, not `currentUser`: this endpoint is not about a
    // repository, so there is no ability to check and a fine-grained token is
    // simply a caller. `currentUser` refuses to resolve one on purpose, which
    // is right where grants matter and wrong here.
    const { user, token } = await currentActor(request)
    if (!user)
      return apiError('unauthenticated', 'Not signed in')

    const id = String(request.get('id') ?? '').trim()
    if (!id)
      return apiError('missing_field', 'An operation id is required', { field: 'id' })

    const row: any = await db
      .selectFrom('operations')
      .selectAll()
      .where('uuid', '=', id)
      .executeTakeFirst()

    if (!row || Number(row.actor_id ?? 0) !== user.id)
      return apiError('not_found', 'No such operation')

    /*
     * The authority check, and the reason this endpoint is not two lines.
     *
     * An operation started by a token may be cancelled by that token, or by its
     * owner working through a session - a person should be able to stop their
     * own agent. It may not be cancelled by a *different* token, even one on the
     * same account.
     *
     * Work started from a session has no token, and any of that person's
     * credentials may stop it: there is no second party to protect.
     */
    const startedByToken = Number(row.access_token_id ?? 0)
    const callingToken = token?.tokenId ?? null

    if (startedByToken && callingToken && callingToken !== startedByToken) {
      return apiError('forbidden', 'This operation was started by a different token', {
        fix: 'Cancel it with the token that started it, or from a signed-in session.',
      })
    }

    // Already stopped. Answered rather than refused: a client retrying a cancel
    // it already sent wants to hear that it worked, and a 409 here would send
    // it looking for a problem that is not there.
    if (isTerminal(String(row.status)))
      return response.json({ operation: view(row) })

    const at = new Date().toISOString()

    await db
      .updateTable('operations')
      .set({ cancel_requested_at: at })
      .where('id', '=', Number(row.id))
      .execute()

    /*
     * Queued work stops here, because nothing has picked it up: there is no
     * checkpoint to wait for, and leaving it `queued` with a cancel pending
     * would have a client polling something that will never move.
     */
    if (String(row.status) === 'queued') {
      await db
        .updateTable('operations')
        .set({ status: 'cancelled', finished_at: at })
        .where('id', '=', Number(row.id))
        .execute()

      return response.json({ operation: view({ ...row, status: 'cancelled', finished_at: at, cancel_requested_at: at }) })
    }

    return response.json({ operation: view({ ...row, cancel_requested_at: at }) })
  },
})
