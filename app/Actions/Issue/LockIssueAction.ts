import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Lock or unlock a conversation.
 *
 * Locking is how a maintainer ends a thread that has stopped being useful, so
 * it holds against everyone who is not maintaining the repository - including
 * the person who opened the issue. That asymmetry is the whole point: an author
 * who could unlock their own issue could reopen the argument the lock ended.
 *
 * What a lock actually prevents lives in `mayComment`, next to the rest of the
 * issue state rules, and is checked by every action that writes to the
 * conversation rather than being re-derived here.
 */
export default new Action({
  name: 'LockIssue',
  description: 'Lock or unlock the conversation on an issue',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:lock')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const raw = request.get('locked')
    if (raw === undefined || raw === null)
      return response.json({ error: 'Locked must be true or false' }, 422)

    // Accepts the string forms too: this arrives from a form as often as from
    // JSON, and `"false"` is truthy.
    const locked = raw === true || raw === 'true' || raw === 1 || raw === '1'
    const unlocked = raw === false || raw === 'false' || raw === 0 || raw === '0'
    if (!locked && !unlocked)
      return response.json({ error: 'Locked must be true or false' }, 422)

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    await db.updateTable('issues').set({ locked }).where('id', '=', Number(issue.id)).execute()

    return response.json({ number, locked })
  },
})
