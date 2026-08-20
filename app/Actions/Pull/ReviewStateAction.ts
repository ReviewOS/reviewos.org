import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { draftFor, pullRequestFor, viewedFiles } from './reviewState'

/**
 * Where the reader got to on this pull request, last time they were here.
 *
 * Answers for the caller and nobody else. A signed-out reader gets an empty
 * answer with `signed_in: false` rather than a 401, because there is nothing
 * secret about it and the page still works: the viewer falls back to local
 * storage, which is what it used before this endpoint existed.
 *
 * `head_sha` comes back so the browser can tell a tick made against the current
 * head from one made against a head that has since been pushed over. The second
 * is not a statement about the file as it now stands.
 */
export default new Action({
  name: 'ReviewState',
  description: 'The signed-in reader\'s progress through a pull request',
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
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    if (!user)
      return response.json({ signed_in: false, head_sha: pullRequest.head_sha, viewed: [], draft: null })

    const [viewed, draft] = await Promise.all([
      viewedFiles(pullRequest.id, user.id),
      draftFor(pullRequest.id, user.id),
    ])

    return response.json({
      signed_in: true,
      head_sha: pullRequest.head_sha,
      viewed,
      draft,
    })
  },
})
