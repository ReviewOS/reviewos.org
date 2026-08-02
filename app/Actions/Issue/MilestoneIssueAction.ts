import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Put an issue in a milestone, or take it out of one.
 *
 * Sending no milestone clears it, which is the only way to say "not in one" -
 * there is no separate remove endpoint, because a milestone is a single value
 * rather than a set.
 *
 * The counters on the milestone move with the issue. They exist so a milestone
 * list can show progress without counting rows per milestone per page, and a
 * counter nobody maintains is worse than no counter.
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

    // Which counter moves depends on the issue's own state, not on the
    // milestone's: a closed issue added to a milestone is closed work.
    const column = issue.state === 'closed' ? 'closed_issues_count' : 'open_issues_count'

    if (previousId !== null) {
      await db
        .updateTable('milestones')
        .set((eb: any) => ({ [column]: eb(column, '-', 1) }))
        .where('id', '=', previousId)
        .where(column, '>', 0)
        .execute()
    }

    if (nextId !== null) {
      await db
        .updateTable('milestones')
        .set((eb: any) => ({ [column]: eb(column, '+', 1) }))
        .where('id', '=', nextId)
        .execute()
    }

    return response.json({ number, milestone: milestone?.title ?? null })
  },
})
