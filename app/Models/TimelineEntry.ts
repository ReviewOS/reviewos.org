import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One thing that happened to an issue or a pull request.
 *
 * An issue is a history, not a body with comments stuck underneath it. "Closed
 * as not planned, reopened two days later, renamed, moved to 1.0" is most of
 * what a reader needs, and none of it is recoverable from the rows those
 * changes wrote: an issue's `state` says it is open now, never that it was
 * closed on Tuesday by somebody who then changed their mind.
 *
 * Polymorphic on the same `commentable` shape as `IssueComment`, so the pull
 * request conversation reuses this rather than growing a parallel table that
 * drifts. Comments stay in their own table: a comment is authored content that
 * can be edited and deleted, an entry is a fact that happened and never
 * changes. Merging them would mean one of the two lying about itself.
 */
export default defineModel({
  name: 'TimelineEntry',
  table: 'timeline_entries',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The whole timeline for one subject, in order. Every read this table
    // serves is that query.
    { name: 'timeline_entries_subject_index', columns: ['subject_type', 'subject_id', 'created_at'] },
  ],

  traits: {
    useUuid: true,
    // Created only. An entry is never edited, so an `updated_at` would be a
    // column that is always equal to `created_at` and occasionally lies.
    useTimestamps: true,
    useSeeder: { count: 40 },
  },

  // Only the actor. `subject_id` is polymorphic - it names an issue or a pull
  // request depending on `subject_type` - so no single-table relation is
  // truthful about it, and declaring one would invite a foreign key that
  // rejects half the rows.
  belongsTo: [{ model: 'User', foreignKey: 'actor_id' }],

  attributes: {
    subject_type: {
      order: 1,
      fillable: true,
      default: 'issue',
      validation: { rule: schema.enum(['issue', 'pull_request']) },
      factory: () => 'issue',
    },

    subject_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * What happened.
     *
     * A closed set, because a timeline is rendered by matching on it: an
     * unrecognised kind would render as nothing at all, which reads to a
     * person as "the history has a hole in it" rather than "this forge does
     * not know that word yet".
     */
    kind: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.enum([
          'closed',
          'reopened',
          'renamed',
          'labeled',
          'unlabeled',
          'assigned',
          'unassigned',
          'milestoned',
          'demilestoned',
          'locked',
          'unlocked',
          // The two halves of a cross reference. `referenced` is the incoming
          // one - "somebody wrote about this over there" - and `mentioned` is
          // the outgoing one, on the timeline of the thing that did the
          // writing. Two kinds rather than one, because a single kind cannot
          // say which direction a reader is looking along the link, and a
          // history that words both ends the same way is a history that has to
          // be decoded.
          'referenced',
          'mentioned',
          'merged',
        ]),
      },
      factory: () => 'closed',
    },

    /**
     * The local actor, when there is one.
     *
     * Optional and paired with `external_actor`, the same rule authorship
     * follows everywhere else: a mirrored event was caused by somebody who
     * usually has no account here.
     */
    actor_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    external_actor: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    /**
     * What the change was about, as text.
     *
     * A label's name, a milestone's title, the old title of a rename. Stored
     * rather than joined, because it has to survive the thing it names: a
     * timeline saying "removed the label wontfix" must still say that after
     * somebody deletes the label, and a join would silently turn it into
     * "removed the label ".
     */
    subject_text: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** The other side of a rename, and nothing else. */
    previous_text: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /**
     * The issue or pull request that caused this, for a cross reference.
     *
     * Only ever set on `referenced`, and only ever a number in this
     * repository: a reference from elsewhere is somebody else's history.
     */
    reference_number: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
