import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { authorizeRepository } from './authorize'
import { recountStars } from './counters'

/**
 * Star a repository, or unstar it.
 *
 * One endpoint, toggling, for the same reason reacting is: the page cannot know
 * whether the star it drew has been pressed since it was drawn, so asking it to
 * choose between add and remove is asking it to guess, and it guesses wrong for
 * anybody with two tabs open.
 *
 * Starring needs read access and nothing more, and it works on an archived
 * repository - a star is a bookmark on something you want to find again, and an
 * archived repository is exactly the kind of thing people bookmark.
 */
export default new Action({
  name: 'Star',
  description: 'Star or unstar a repository',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const repositoryId = Number(auth.context.repository.id)

    const existing = await db
      .selectFrom('stars')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    if (existing) {
      // By person rather than by id: two rapid stars from one person can leave
      // two rows, and unstarring should leave none rather than one.
      await db
        .deleteFrom('stars')
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', user.id)
        .execute()
    }
    else {
      await db.insertInto('stars').values({ repository_id: repositoryId, user_id: user.id }).execute()
    }

    const count = await recountStars(repositoryId)

    return response.json({ starred: !existing, stars: count ?? 0 })
  },
})
