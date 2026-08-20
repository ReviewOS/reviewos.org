import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { record } from './timeline'

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

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    milestone: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'issue:milestone')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

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

    // Read before the update, because "removed this from 1.0" needs the name of
    // the milestone being left and the row is about to stop pointing at it.
    const previous: any = previousId === null
      ? null
      : await db.selectFrom('milestones').select(['title']).where('id', '=', previousId).executeTakeFirst()
    const previousTitle = previous?.title ? String(previous.title) : null
    const nextId = milestone ? Number(milestone.id) : null

    if (previousId === nextId)
      return response.json({ number, milestone: milestone?.title ?? null })

    await db
      .updateTable('issues')
      .set({ milestone_id: nextId })
      .where('id', '=', Number(issue.id))
      .execute()

    await record(
      { type: 'issue', id: Number(issue.id) },
      milestone ? 'milestoned' : 'demilestoned',
      user ? Number(user.id) : null,
      // On removal the title is the one being left, which is what a reader
      // needs: "removed this from 1.0" says more than "removed this".
      { text: milestone ? String(milestone.title) : previousTitle },
    )

    return response.json({ number, milestone: milestone?.title ?? null })
  },
})
