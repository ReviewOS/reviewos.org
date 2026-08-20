import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { notifyProgramsOnly } from '../../Notifications/emit'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { mayTransition, transitionDraft, transitionPullRequest } from './state'

const TRANSITIONS = ['close', 'reopen', 'draft', 'ready'] as const

type Transition = typeof TRANSITIONS[number]

function isTransition(value: string): value is Transition {
  return (TRANSITIONS as readonly string[]).includes(value)
}

/**
 * Close, reopen, or move a pull request between draft and ready for review.
 *
 * One endpoint for four transitions because they share the same question: is
 * this pull request still something that can change. Merging is deliberately not
 * here; it moves a branch, and that is not a state field.
 *
 * Closing a pull request that other pull requests are stacked on top of is
 * allowed and leaves them orphaned rather than refusing. `orphanReason` in
 * `stack.ts` is what surfaces that, so the honest thing is to let the author
 * close it and show the consequence, not to trap them behind their own stack.
 */
export default new Action({
  name: 'UpdatePullRequestState',
  description: 'Close, reopen, or change the draft state of a pull request',
  method: 'PUT',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    state: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const transition = String(request.get('state') ?? '')
    if (!isTransition(transition))
      return response.json({ error: 'State must be close, reopen, draft, or ready' }, 422)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      // `title` among them: the notification below reads it.
      .select(['id', 'state', 'draft', 'author_id', 'head_branch', 'title'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const isAuthor = Number(pullRequest.author_id) === user.id
    if (!mayTransition({ isAuthor, canClose: can('pull:close') }))
      return response.json({ error: 'Forbidden' }, 403)

    // Only reopening needs to know whether the branch survived, and asking git
    // costs a process, so it is asked for only when the answer can change the
    // outcome.
    const headExists = transition === 'reopen'
      ? await branchExists(String(request.get('owner')), repository.name, String(pullRequest.head_branch))
      : true

    const current = {
      state: pullRequest.state as 'open' | 'closed' | 'merged',
      draft: Boolean(pullRequest.draft),
      headExists,
    }

    if (transition === 'draft' || transition === 'ready') {
      const result = transitionDraft(current, transition)
      if (!result.ok)
        return response.json({ error: result.error }, result.status)

      if (result.changed) {
        await db
          .updateTable('pull_requests')
          .set({ draft: result.draft })
          .where('id', '=', Number(pullRequest.id))
          .execute()

        /*
         * A draft becoming ready, for the programs watching.
         *
         * An agent configured to review what is ready has no other way to
         * notice: nothing about the pull request changes except a boolean, so
         * there is no push, no comment and no review request to observe.
         *
         * Only in that direction. Going back to draft is the author saying
         * "not yet", and an event announcing it would invite exactly the
         * attention they just withdrew.
         */
        if (transition === 'ready') {
          await notifyProgramsOnly('pr:ready_for_review', {
            actorId: user.id,
            actorHandle: user.handle,
            repositoryId: repository.id,
            owner: String(request.get('owner') ?? '').trim().toLowerCase(),
            repository: repository.name,
            subjectType: 'pull_request',
            subjectId: Number(pullRequest.id),
            number,
            title: String(pullRequest.title ?? ''),
          })
        }
      }

      return response.json({ number, state: current.state, draft: result.draft })
    }

    const result = transitionPullRequest(current, transition)
    if (!result.ok)
      return response.json({ error: result.error }, result.status)

    if (result.changed) {
      const closed = result.state === 'closed'

      await db
        .updateTable('pull_requests')
        .set({
          state: result.state,
          closed_at: closed ? new Date().toISOString() : null,
          closed_by_id: closed ? user.id : null,
        })
        .where('id', '=', Number(pullRequest.id))
        .execute()
    }

    // A close, not a reopen, and not a draft toggle. See the note in
    // `UpdateIssueStateAction`: a notification for every state flip teaches a
    // thread's watchers that the product is noisy.
    if (result.state === 'closed') {
      const { notify } = await import('../../Notifications/emit')
      await notify('pr:closed', {
        actorId: user.id,
        actorHandle: user.handle,
        repositoryId: repository.id,
        owner: String(request.get('owner') ?? '').trim().toLowerCase(),
        repository: repository.name,
        subjectType: 'pull_request',
        subjectId: Number(pullRequest.id),
        number,
        title: String((pullRequest as any).title ?? ''),
        subscribeActor: false,
      })
    }

    return response.json({ number, state: result.state, draft: current.draft })
  },
})

/** Whether a branch still points at a commit. */
async function branchExists(owner: string, repositoryName: string, branch: string): Promise<boolean> {
  const resolved = repositoryPath(owner, repositoryName)
  if (!resolved.ok)
    return false

  const result = await runGit(resolved.path!, ['rev-parse', '--verify', `refs/heads/${branch}`])

  return result.ok && result.stdout.trim().length > 0
}
