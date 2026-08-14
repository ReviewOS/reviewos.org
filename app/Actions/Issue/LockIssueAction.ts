import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { record } from './timeline'

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

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. `owner` plus one of `repo` or `repository` addresses
   * every repository-scoped endpoint - see `authorizeRepository` - and a caller
   * who forgets one should be told which field is missing rather than shown a
   * 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    number: { rule: schema.number().required() },
    locked: { rule: schema.boolean() },
  },

  responses: {
    200: { description: 'Whether the issue is now locked.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Locking a conversation needs write access to the repository.' },
    404: { description: 'No such repository or issue, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:lock')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

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

    await record(
      { type: 'issue', id: Number(issue.id) },
      locked ? 'locked' : 'unlocked',
      user ? Number(user.id) : null,
    )

    return response.json({ number, locked })
  },
})
