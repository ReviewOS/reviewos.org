import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A comment on an issue or a pull request.
 *
 * Polymorphic on purpose: a comment does not care which it is attached to, and
 * the pull request conversation reuses this rather than growing a parallel
 * table that drifts.
 */
export default defineModel({
  name: 'IssueComment',
  table: 'issue_comments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'issue_comments_subject_index', columns: ['commentable_type', 'commentable_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 60 },
  },

  belongsTo: [{ model: 'Issue', foreignKey: 'commentable_id' }, { model: 'User', foreignKey: 'author_id' }],

  attributes: {
    commentable_type: {
      order: 1,
      fillable: true,
      default: 'issue',
      validation: { rule: schema.enum(['issue', 'pull_request']) },
      factory: () => 'issue',
    },

    commentable_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    author_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    body: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: faker => faker.lorem.paragraph(),
    },

    edited_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    edited_by_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
