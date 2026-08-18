import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { draftFromRequest, pullRequestFor, saveDraft } from './reviewState'

/**
 * Keep, or discard, the comment somebody is halfway through writing.
 *
 * An empty body discards it, which is what the viewer sends when the draft is
 * sent as a real comment or deleted. That is one endpoint rather than two
 * because the caller has one thing to say - here is my draft, or I no longer
 * have one - and splitting it would put the rule about what counts as empty in
 * two places.
 *
 * `pull:review`, not `repository:read`: a draft is a comment that has not been
 * sent yet, and somebody who could never post it has no use for one kept on our
 * side. The browser keeps its own copy regardless, so nothing is lost by the
 * refusal.
 */
export default new Action({
  name: 'SaveReviewDraft',
  description: 'Store or clear the reader\'s unsent review comment',
  method: 'PUT',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'pull:review')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const parsed = draftFromRequest(request)
    if (!parsed.ok)
      return response.json({ error: parsed.error }, 422)

    await saveDraft(pullRequest.id, user.id, parsed.draft)

    return response.json({ draft: parsed.draft })
  },
})
