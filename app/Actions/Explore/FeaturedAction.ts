import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { featured } from './featured'

/**
 * The repositories this instance puts its name behind.
 *
 * The same read the landing page renders, exposed because a page that reads
 * through an action module and an API that does not is exactly the drift
 * `tests/unit/api-parity.test.ts` exists to catch: an agent or a client that
 * wants what the front page shows would otherwise have to scrape the HTML.
 *
 * Public repositories only, enforced inside `featured()` rather than here, for
 * the reason `ExploreAction` gives at length - a listing is the one surface
 * where a visibility mistake is not a leak to one person.
 *
 * `limit` is the only input, and it takes from the front: the list is ordered
 * deliberately rather than by stars, so the first three are the three to show
 * in a sidebar. There is nothing to paginate - a curated list that needed a
 * cursor would be a search result wearing the wrong name.
 */
export default new Action({
  name: 'Featured',
  description: 'The repositories this instance features on its landing page',
  method: 'GET',

  validations: {
    limit: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const repositories = await featured()
    const asked = Number(request.get('limit'))

    // A limit that is not a positive number is not an error worth refusing a
    // read over; it is a caller who sent nothing, or sent junk, and either way
    // the whole list is the right answer.
    const limit = Number.isInteger(asked) && asked > 0 ? asked : repositories.length

    return response.json({ repositories: repositories.slice(0, limit) })
  },
})
