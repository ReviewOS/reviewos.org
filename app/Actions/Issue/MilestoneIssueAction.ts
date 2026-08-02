import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Put an issue in a milestone, or take it out of one.
 *
 * Sending no milestone clears it, which is the only way to say "not in one" -
 * there is no separate remove endpoint, because a milestone is a single value
 * rather than a set.
 *
 * There are no progress counters on a milestone to maintain. There were meant
 * to be, and the code here moved them for a while against columns the table
 * has never had - the model does not declare them and no migration ever added
 * them, so every write here failed. The milestone list counts its issues
 * instead, which is one grouped query for the whole page: a counter is only
 * worth denormalizing when the query it saves is expensive, and this one is
 * not.
 */
export default new Action({
  name: 'MilestoneIssue',
  description: 'Set or clear the milestone on an issue',
  method: 'PUT',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:milestone')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'milestone_id', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    const requested = request.get('milestone')
    const title = requested === undefined || requested === null ? null : String(requested).trim()

    // Belonging to this repository, so a milestone from another one cannot be
    // attached and leak its name onto this issue.
    const milestone = title
      ? await db
          .selectFrom('milestones')
          .select(['id', 'title'])
          .where('repository_id', '=', repository.id)
          .where('title', '=', title)
          .executeTakeFirst()
      : null

    if (title && !milestone)
      return response.json({ error: `No such milestone: ${title}` }, 422)

    const previousId = issue.milestone_id === null ? null : Number(issue.milestone_id)
    const nextId = milestone ? Number(milestone.id) : null

    if (previousId === nextId)
      return response.json({ number, milestone: milestone?.title ?? null })

    await db
      .updateTable('issues')
      .set({ milestone_id: nextId })
      .where('id', '=', Number(issue.id))
      .execute()

    return response.json({ number, milestone: milestone?.title ?? null })
  },
})
