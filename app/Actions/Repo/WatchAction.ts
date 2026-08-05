import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { authorizeRepository } from './authorize'

/** What a person can ask to hear about. */
export const SUBSCRIPTIONS = ['all', 'participating', 'ignore'] as const

/**
 * Set how much somebody wants to hear about a repository.
 *
 * Not a toggle, unlike starring, because there are three answers and the middle
 * one is the one people want: tell me about threads I am in. A two-state watch
 * button makes everybody choose between silence and every issue anyone opens,
 * and what they choose is silence.
 *
 * `ignore` is stored as a row rather than as the absence of one. "I have never
 * decided" and "I have decided not to hear about this" are different states,
 * and only the second one should survive somebody being mentioned in a thread.
 */
export default new Action({
  name: 'Watch',
  description: 'Set or clear a watch on a repository',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const repositoryId = Number(auth.context.repository.id)
    const raw = String(request.get('subscription') ?? '').trim().toLowerCase()

    // No subscription at all means stop watching: back to whatever the defaults
    // would have said, which is not the same as `ignore`.
    if (!raw || raw === 'none') {
      await db
        .deleteFrom('watches')
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', user.id)
        .execute()

      return response.json({ watching: false, subscription: null })
    }

    if (!(SUBSCRIPTIONS as readonly string[]).includes(raw))
      return response.json({ error: 'No such subscription' }, 422)

    const existing = await db
      .selectFrom('watches')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('watches')
        .set({ subscription: raw })
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', user.id)
        .execute()
    }
    else {
      await db
        .insertInto('watches')
        .values({ repository_id: repositoryId, user_id: user.id, subscription: raw })
        .execute()
    }

    return response.json({ watching: raw !== 'ignore', subscription: raw })
  },
})
