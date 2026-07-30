import { Action } from '@stacksjs/actions'
import { allocateNumber, authorizeRepository } from '../Repo/authorize'

/**
 * Open an issue.
 *
 * The number is allocated from the repository's shared counter before the
 * insert, so an issue and a pull request never collide on `#12`.
 */
export default new Action({
  name: 'CreateIssue',
  description: 'Open an issue on a repository',
  method: 'POST',

  async handle(request: any) {
    // Anyone who can read a repository may open an issue on it; that is what
    // makes an issue tracker useful to people who are not contributors.
    const auth = await authorizeRepository(request, 'issue:open')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const title = String(request.get('title') ?? '').trim()
    if (!title)
      return response.json({ error: 'An issue needs a title' }, 422)

    if (title.length > 255)
      return response.json({ error: 'That title is too long' }, 422)

    const milestoneId = request.get('milestone_id') ? Number(request.get('milestone_id')) : null
    if (milestoneId !== null) {
      const milestone = await db
        .selectFrom('milestones')
        .select(['id'])
        .where('id', '=', milestoneId)
        .where('repository_id', '=', repository.id)
        .executeTakeFirst()

      // A milestone from another repository would show this issue in a list it
      // does not belong to.
      if (!milestone)
        return response.json({ error: 'No such milestone' }, 422)
    }

    const number = await allocateNumber(repository.id)

    const created = await db
      .insertInto('issues')
      .values({
        repository_id: repository.id,
        number,
        title,
        body: String(request.get('body') ?? ''),
        author_id: user.id,
        state: 'open',
        milestone_id: milestoneId,
        locked: false,
        comments_count: 0,
        is_pull_request: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    await db
      .updateTable('repositories')
      .set((eb: any) => ({ open_issues_count: eb('open_issues_count', '+', 1) }))
      .where('id', '=', repository.id)
      .execute()

    return response.json({
      id: Number(created?.id),
      number,
      title,
      state: 'open',
      url: `/${request.get('owner')}/${repository.name}/issues/${number}`,
    }, 201)
  },
})
