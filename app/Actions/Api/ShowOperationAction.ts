import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { conditional } from '../../Api/etag'
import { etagForOperation, retryAfterFor, view } from '../../Api/operations'
import { currentActor } from '../Identity/lookup'

/**
 * How an operation is going.
 *
 * The endpoint the whole pattern points at: a caller that started work polls
 * this and nothing else, whatever the work was.
 *
 * **Cheap on purpose.** The design asks clients to poll, so it carries an
 * `ETag` and answers 304 while nothing has changed, and it sends `Retry-After`
 * so a client does not have to guess a cadence. A pattern that told clients to
 * poll and then made polling expensive would be advice nobody could follow.
 */
export default new Action({
  name: 'ShowOperation',
  description: 'The status of a long-running operation',
  method: 'GET',

  validations: {
    id: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    // `currentActor`, not `currentUser`: this endpoint is not about a
    // repository, so there is no ability to check and a fine-grained token is
    // simply a caller. `currentUser` refuses to resolve one on purpose, which
    // is right where grants matter and wrong here.
    const { user } = await currentActor(request)
    if (!user)
      return apiError('unauthenticated', 'Not signed in')

    const id = String(request.get('id') ?? '').trim()
    if (!id)
      return apiError('missing_field', 'An operation id is required', { field: 'id' })

    const row = await db
      .selectFrom('operations')
      .selectAll()
      .where('uuid', '=', id)
      .executeTakeFirst()

    /*
     * Somebody else's operation reads as missing rather than forbidden, exactly
     * as a private repository does. An operation id names work on a subject,
     * and "you may not see that one" confirms the subject exists.
     */
    if (!row || Number(row.actor_id ?? 0) !== user.id)
      return apiError('not_found', 'No such operation')

    const tag = etagForOperation(row)
    const retryAfter = retryAfterFor(String(row.status))

    return await conditional(request, tag, async () => {
      return response.json({ operation: view(row) }, {
        status: 200,
        headers: retryAfter === null ? {} : { 'Retry-After': String(retryAfter) },
      })
    })
  },
})
