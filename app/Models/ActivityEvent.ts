import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Something somebody did, recorded so it can be listed later.
 *
 * Distinct from a notification, and the difference is who it is for. A
 * notification is addressed: it exists because *you* should know. An activity
 * event is a matter of record: it exists because it happened, and whether
 * anybody reads it is decided at query time. Conflating them is why forges end
 * up with feeds that read like somebody else's inbox.
 *
 * **`is_public` is written, not derived.** Whether an event may be shown
 * depends on the repository's visibility at the moment it happened, and a
 * repository can be made private later. Deriving it at read time would mean a
 * repository going private retroactively hides its whole history from the
 * people who were there - and, far worse, a repository going *public* would
 * retroactively expose activity from when it was not.
 *
 * A denormalized `repository_id` and `organization_id` sit beside the
 * polymorphic subject on purpose. The feed asks "what happened in the
 * repositories I watch", and answering that through the subject would need a
 * union across every subject table on every page load.
 */
export default defineModel({
  name: 'ActivityEvent',
  table: 'activity_events',
  primaryKey: 'id',
  autoIncrement: true,

  /*
   * The two the feed actually reads by, both composite and both ending in
   * `created_at`.
   *
   * This is the query that hurts first at scale, and it hurts in a specific
   * way: an index on `actor_id` alone lets Postgres find the rows and then
   * sort them, which on a prolific account means reading every event they ever
   * produced to return twenty. Ending the index on the column being ordered is
   * what turns that into a range scan that stops after twenty.
   */
  indexes: [
    { name: 'activity_events_actor_index', columns: ['actor_id', 'created_at'] },
    { name: 'activity_events_repository_index', columns: ['repository_id', 'created_at'] },
    { name: 'activity_events_subject_index', columns: ['subject_type', 'subject_id'] },
  ],

  traits: {
    useTimestamps: true,
  },

  /*
   * `foreignKey` rather than the default `user_id`, so the column is named for
   * the role it plays. A feed row has an actor, not a user - and a table with
   * both `actor_id` and an unrelated `user_id` beside it is one where the next
   * query picks the wrong one.
   *
   * Both cascade. An event with no actor is a sentence with no subject -
   * "opened a pull request" is not something a feed can render - and an event
   * in a repository that no longer exists points at a page that 404s. A gap in
   * a feed is better than a row that cannot be read.
   *
   * Declaring them is also what makes the columns `bigint`. A plain numeric
   * attribute generates `integer`, and an `integer` foreign key against a
   * `bigint` primary key is a mismatch Postgres compares happily and that stays
   * invisible until an id passes two billion.
   */
  belongsTo: [
    { model: 'User', foreignKey: 'actor_id', relationName: 'actor', onDelete: 'cascade' },
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
  ],

  attributes: {
    /** Who did it. The column comes from the relation above. */
    actor_id: {
      required: true,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * What they did, as a past-tense verb.
     *
     * A string rather than an enum column, so adding one is a code change
     * rather than a migration. A row naming a verb nothing renders is inert,
     * which is the right failure: a feed that refused to load because of one
     * unrecognised row would be a feed that a single deploy could break.
     */
    verb: {
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(64) },
    },

    subject_type: {
      required: true,
      fillable: true,
      validation: { rule: schema.string().max(32) },
    },

    subject_id: {
      required: true,
      fillable: true,
      validation: { rule: schema.number() },
    },

    /** Where it happened. Null for an event that is not about a repository. */
    repository_id: {
      required: false,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The organization that owns it, when one does. */
    organization_id: {
      required: false,
      fillable: true,
      validation: { rule: schema.number() },
    },

    /**
     * Whether this may be shown to somebody who is not a collaborator.
     *
     * Decided when the row is written, from the repository's visibility at that
     * moment. See the note above: deriving it at read time makes a visibility
     * change rewrite history in both directions, and the direction that leaks
     * is the one nobody notices.
     */
    is_public: {
      required: true,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
    },

    /**
     * Enough to render the sentence without joining.
     *
     * A feed page shows twenty events, and reconstructing each one's title from
     * its subject table is twenty queries across five tables. The title as it
     * was is also the honest thing to show: an issue renamed since is still the
     * issue somebody opened under the old name.
     */
    detail: {
      required: false,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
    },
  },
} as const)
