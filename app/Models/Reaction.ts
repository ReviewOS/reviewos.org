import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One person's reaction to one thing.
 *
 * Polymorphic for the same reason `IssueComment` is: an issue body, a comment
 * on an issue, and a comment on a review are all things somebody reacts to, and
 * a table per subject would drift the moment one of them grew a rule the others
 * did not.
 *
 * A row is the whole state. There is no count column: the count is
 * `COUNT(*) GROUP BY content`, which the issue page already needs to run once
 * for the page and which cannot disagree with the rows the way a counter can.
 * Denormalizing is worth it when the query it saves is expensive, and this one
 * is an index scan over the reactions of one issue.
 *
 * The unique index is the feature, not an optimization: it is what makes
 * reacting idempotent. Clicking twice is a person checking whether it worked,
 * not a person reacting twice.
 */
export default defineModel({
  name: 'Reaction',
  table: 'reactions',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'reactions_subject_index', columns: ['subject_type', 'subject_id'] },
    { name: 'reactions_one_per_person_index', columns: ['subject_type', 'subject_id', 'user_id', 'content'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 80 },
  },

  belongsTo: [{ model: 'User', foreignKey: 'user_id' }],

  attributes: {
    subject_type: {
      order: 1,
      fillable: true,
      default: 'issue',
      validation: { rule: schema.enum(['issue', 'issue_comment', 'review_comment']) },
      factory: () => 'issue',
    },

    subject_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * Who reacted. Required, unlike a comment's author.
     *
     * A comment can be mirrored from a forge where its author has no account
     * here, and the words are still worth showing. A reaction is not: it is a
     * tally, and a tally of people who cannot be identified is a number nobody
     * can act on. A mirrored reaction is dropped at import rather than
     * attributed to nobody.
     */
    user_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * Which one, from the fixed eight in `app/Actions/Markdown/emoji.ts`.
     *
     * An enum rather than free text, because the set is the interface: eight
     * buttons in a fixed order. Arbitrary emoji would make the row of reactions
     * under a comment a different shape on every comment, and reacting would
     * stop being a one-click act.
     */
    content: {
      order: 4,
      fillable: true,
      validation: { rule: schema.enum(['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes']).required() },
      factory: faker => faker.helpers.arrayElement(['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes']),
    },
  },
} as const)
