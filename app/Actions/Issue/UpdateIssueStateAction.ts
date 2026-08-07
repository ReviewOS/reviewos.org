import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { recountOpenIssues } from '../Repo/counters'
import { record } from './timeline'
import { transitionIssue } from './state'

/**
 * Close or reopen an issue.
 *
 * The author may close their own issue without triage rights: withdrawing a
 * report you filed is not a privileged act.
 */
export default new Action({
  name: 'UpdateIssueState',
  description: 'Close or reopen an issue',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const transition = String(request.get('state') ?? '')
    if (transition !== 'close' && transition !== 'reopen')
      return response.json({ error: 'State must be close or reopen' }, 422)

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'state', 'locked', 'author_id', 'is_pull_request'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    const isAuthor = Number(issue.author_id) === user.id
    if (!isAuthor && !can('issue:close'))
      return response.json({ error: 'Forbidden' }, 403)

    const result = transitionIssue(
      { state: issue.state as 'open' | 'closed', locked: Boolean(issue.locked) },
      transition,
      request.get('reason') ? String(request.get('reason')) : null,
    )

    if (!result.ok)
      return response.json({ error: result.error }, result.status)

    // The previous state used to matter, because the counter was adjusted by
    // one and a repeated close would have moved it twice. It is recomputed now,
    // so only the new state does.
    const nowOpen = result.state === 'open'

    await db
      .updateTable('issues')
      .set({
        state: result.state,
        state_reason: result.reason,
        closed_at: nowOpen ? null : new Date().toISOString(),
        closed_by_id: nowOpen ? null : user.id,
      })
      .where('id', '=', Number(issue.id))
      .execute()

    // The counter only tracks issues, so a pull request must not move it. It is
    // recomputed rather than adjusted, which also means a repeated close cannot
    // move it twice - see `app/Actions/Repo/counters`.
    if (!issue.is_pull_request)
      await recountOpenIssues(Number(repository.id))

    await record(
      { type: 'issue', id: Number(issue.id) },
      result.state === 'closed' ? 'closed' : 'reopened',
      user ? Number(user.id) : null,
    )

    // Only a close is worth telling people about. A reopen is usually the same
    // person correcting themselves a moment later, and a notification for it
    // teaches the thread's watchers that the product is noisy.
    if (result.state === 'closed') {
      const { notify } = await import('../../Notifications/emit')
      await notify('issue:closed', {
        actorId: user.id,
        actorHandle: user.handle,
        repositoryId: repository.id,
        owner: String(request.get('owner') ?? '').trim().toLowerCase(),
        repository: repository.name,
        subjectType: 'issue',
        subjectId: Number(issue.id),
        number,
        // Closing somebody else's issue does not sign you up for the rest of it.
        subscribeActor: false,
      })
    }

    return response.json({ number, state: result.state, state_reason: result.reason })
  },
})
