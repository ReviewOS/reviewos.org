import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { safeRedirect, wantsHtml } from '../Auth/session'
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

  /*
   * Declared here so the generated reference lists them and the validator
   * enforces them from the same object. `owner` plus one of `repo` or
   * `repository` is how every repository-scoped endpoint is addressed - see
   * `authorizeRepository` - and a caller that forgets one should be told that
   * rather than shown a 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The star was added or removed. `starred` says which, and `stars` is the count after it.' },
    302: { description: 'A browser form was answered with a redirect back to the page it came from. Scripts get the JSON above.' },
    401: { description: 'Unauthenticated. A star belongs to somebody.' },
    404: { description: 'No such repository, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: RequestInstance) {
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

    /*
     * A browser gets the page back; a script gets the JSON.
     *
     * The star button is a single-button form, because this product's pages run
     * no client-side JavaScript and a form is the only control that can post
     * without any - the same shape as a reaction and a task-list checkbox. A
     * form left to follow this response would land the reader on a page of JSON.
     *
     * `next` is checked rather than trusted: `safeRedirect` refuses anything
     * that is not a path on this host, because an open redirect on an
     * authenticated POST is a real one.
     */
    if (wantsHtml(request)) {
      const home = `/${String(request.get('owner') ?? '')}/${String(auth.context.repository.name ?? '')}`

      return response.redirect(safeRedirect(request.get('next'), home))
    }

    return response.json({ starred: !existing, stars: count ?? 0 })
  },
})
