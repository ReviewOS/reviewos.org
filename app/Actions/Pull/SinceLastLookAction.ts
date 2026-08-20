import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { lastSeenHead, sinceLastLook } from './incremental'
import { pullRequestFor } from './reviewState'

/**
 * Which files have changed since this reader last looked at this pull request.
 *
 * Paths rather than a diff. The reviewer already has the diff on screen; what
 * they are missing is which of its three hundred files their earlier conclusion
 * no longer covers. Answering with a list lets the viewer filter what is
 * already there instead of fetching a second copy of it.
 *
 * `looked: false` when we have no record of them reading it, which is not an
 * error and is the common case for a first visit. The interface offers nothing
 * rather than offering a filter that would hide everything.
 */
export default new Action({
  name: 'SinceLastLook',
  description: 'The files that changed since this reader last read this pull request',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    since: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    if (!user)
      return response.json({ looked: false, since: null })

    // An explicit sha wins, so a reader can ask the same question about any
    // point they choose. Checked against the pull request's own history by git
    // rather than trusted: an unknown revision comes back as a failed diff.
    const asked = String(request.get('since') ?? '').trim()
    const since = asked || await lastSeenHead(pullRequest.id, user.id)

    if (!since)
      return response.json({ looked: false, since: null })

    const row = await db
      .selectFrom('pull_requests')
      .select(['base_sha'])
      .where('id', '=', pullRequest.id)
      .executeTakeFirst()

    const result = await sinceLastLook({
      owner,
      repository: repository.name,
      base: String(row?.base_sha ?? ''),
      head: pullRequest.head_sha,
      lastSeen: since,
    })

    // The sha they last saw can be gone: a force-push leaves it unreachable and
    // a garbage collection removes it. Saying so is the answer, because the
    // alternative is a filter that silently hides nothing or everything.
    if (!result)
      return response.json({ looked: true, since, unreadable: true })

    return response.json({
      looked: true,
      since,
      head: pullRequest.head_sha,
      ...result,
    })
  },
})
