import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { allowedStrategies, defaultStrategy, isMergeStrategy } from './merge'
import { attemptAutoMerge } from './autoMerge'

/**
 * Arm auto-merge: merge this pull request the moment its requirements are met.
 *
 * `pull:merge`, because arming is scheduling a merge: the person arming is
 * the person who will be recorded as having merged, and their permission is
 * what the eventual attempt runs under.
 *
 * A strategy the repository disallows is refused at arm time, not at fire
 * time. The merge action would refuse it anyway, but that refusal would
 * happen when nobody is looking - an arm that can never fire is a promise
 * the product knows it will break, and it should say so while somebody is
 * there to hear it.
 *
 * Arming a pull request whose requirements are already met merges it now.
 * "As soon as" starts at the click.
 */
export default new Action({
  name: 'EnableAutoMerge',
  description: 'Merge automatically once requirements are met',
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
    strategy: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'pull:merge')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const strategy = String(request.get('strategy') ?? defaultStrategy(repository as any))

    if (!isMergeStrategy(strategy))
      return response.json({ error: 'Unknown merge strategy' }, 422)

    if (!allowedStrategies(repository as any).includes(strategy))
      return response.json({ error: `This repository does not allow ${strategy} merges` }, 422)

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state', 'draft'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    if (pullRequest.state !== 'open')
      return response.json({ error: 'Only an open pull request can auto-merge' }, 409)

    await db
      .updateTable('pull_requests')
      .set({ auto_merge_strategy: strategy, auto_merge_by_id: Number(user.id) })
      .where('id', '=', Number(pullRequest.id))
      .execute()

    const attempt = await attemptAutoMerge(Number(pullRequest.id))

    return response.json({
      armed: true,
      strategy,
      merged: attempt.merged,
    })
  },
})
