import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A handle that is taken, and points somewhere else.
 *
 * ## What this is for
 *
 * Handles are first come, first served: `/{handle}` is a user or an
 * organization, one namespace, and whoever claims a name has it. That rule is
 * simple and it needs one escape hatch, because a name can stop being the
 * right one while the links to it keep working - an organization renames, two
 * projects merge, or a mirror arrives under the upstream's name when the
 * instance already calls it something shorter. `stacksjs` and `stacks` are
 * exactly that: the GitHub organization is `stacksjs`, this instance has
 * always called it `stacks`, and both names will be typed.
 *
 * So an alias does two things at once, and both matter:
 *
 * - **It redirects.** `/stacksjs` and `/stacksjs/stacks/issues/4` land on the
 *   canonical owner, with the rest of the path intact. A permanent redirect,
 *   because the canonical name is the answer and every cache and crawler
 *   should learn it once.
 * - **It reserves.** The row occupies the handle in the same namespace users
 *   and organizations draw from, so nobody can claim `stacksjs` and silently
 *   take over an address that used to reach somebody else. An alias that did
 *   not reserve would be worse than no alias: the redirect would work until
 *   the day it quietly pointed at a stranger.
 *
 * ## Not a second name for the owner
 *
 * The canonical handle stays the only one anything renders. Pages, clone URLs
 * and the API answer with the owner's real handle, and the alias exists purely
 * so an old or upstream name still arrives. Two names that both render is how
 * a project ends up with two of every URL and a search engine that cannot
 * decide which is real.
 */
export default defineModel({
  name: 'OwnerAlias',
  table: 'owner_aliases',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The lookup on every miss: is this taken name pointing somewhere?
    { name: 'owner_aliases_handle_index', columns: ['handle'], unique: true },
  ],

  traits: {
    useTimestamps: true,
  },

  attributes: {
    /**
     * The name being redirected from.
     *
     * Unique across this table, and checked against users and organizations
     * when it is claimed - the three together are one namespace, because they
     * all live at `/{handle}`.
     */
    handle: {
      order: 1,
      fillable: true,
      required: true,
      unique: true,
      validation: { rule: schema.string().required().max(39) },
      factory: faker => faker.string.alphanumeric(10).toLowerCase(),
    },

    /**
     * Which kind of owner it points at.
     *
     * Polymorphic for the same reason `repositories.owner_type` is: a
     * repository, and a profile page, belong to a user or an organization and
     * the two are not interchangeable. Reading one as the other is how a
     * redirect lands on a stranger who happens to share an id.
     */
    owner_type: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.enum(['user', 'organization']) },
      factory: () => 'organization',
    },

    owner_id: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },
  },
})
