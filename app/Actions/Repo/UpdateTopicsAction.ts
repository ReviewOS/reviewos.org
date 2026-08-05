import { Action } from '@stacksjs/actions'
import { authorizeRepository } from './authorize'
import { decideTopics, topicChanges } from './topics'

/**
 * Set the topics on a repository.
 *
 * The whole list at once rather than add and remove endpoints, because that is
 * how the interface presents it - a field somebody edits and submits - and two
 * endpoints would mean the page reconstructing the difference client-side and
 * getting it wrong when two tabs are open.
 *
 * Underneath it is still a difference: a topic that did not change keeps its
 * row, and with it the only record of when this repository started calling
 * itself that.
 */
export default new Action({
  name: 'UpdateTopics',
  description: 'Set the topics on a repository',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)
    const decision = decideTopics(request.get('topics'))

    const held: any[] = await db
      .selectFrom('repo_topics')
      .select(['topic'])
      .where('repository_id', '=', repositoryId)
      .execute()

    const current = held.map(row => String(row.topic))
    const { add, remove } = topicChanges(current, decision.topics)

    if (remove.length > 0) {
      // One statement per topic rather than an `IN`, because the query builder
      // renders `in $1` on a delete - see app/Actions/Support/rows.ts. There
      // are at most twenty of these.
      for (const topic of remove) {
        await db
          .deleteFrom('repo_topics')
          .where('repository_id', '=', repositoryId)
          .where('topic', '=', topic)
          .execute()
      }
    }

    for (const topic of add)
      await db.insertInto('repo_topics').values({ repository_id: repositoryId, topic }).execute()

    return response.json({
      topics: decision.topics,
      added: add,
      removed: remove,
      // Reported rather than dropped quietly: somebody who typed a topic that
      // could not be used has to be told, or they stop trusting the field.
      rejected: decision.rejected,
    })
  },
})
