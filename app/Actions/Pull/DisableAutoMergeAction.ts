import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Disarm auto-merge.
 *
 * The same ability that arms it. Anybody who could press the merge button may
 * also unpress this one - disarming is strictly less consequential than
 * arming, and gating it tighter would strand an arm behind whoever set it.
 */
export default new Action({
  name: 'DisableAutoMerge',
  description: 'Stop a pull request from merging automatically',
  // POST rather than DELETE: the disarm button is a plain HTML form, and a
  // form speaks two verbs. The router carries no method override.
  method: 'POST',

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
    const auth = await authorizeRepository(request, 'pull:merge')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    await db
      .updateTable('pull_requests')
      .set({ auto_merge_strategy: null, auto_merge_by_id: null })
      .where('id', '=', Number(pullRequest.id))
      .execute()

    return response.json({ armed: false })
  },
})
