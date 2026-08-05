import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A topic on a repository: `typescript`, `git`, `code-review`.
 *
 * A row per topic rather than a list on the repository, because the whole point
 * of a topic is the query that runs the other way - every repository tagged
 * `rust` - and a comma-joined string cannot be indexed for that. It is also the
 * shape phase 6 needs to browse by topic without parsing anything.
 *
 * Normalised to lower case with spaces as dashes before it is stored, so
 * `TypeScript` and `typescript` are one topic, and so are `code review` and
 * `code-review`. The rule lives in `app/Actions/Repo/topics.ts`, tested there.
 */
export default defineModel({
  name: 'RepoTopic',
  table: 'repo_topics',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One row per topic per repository.
    { name: 'repo_topics_repo_topic_index', columns: ['repository_id', 'topic'], unique: true },
    // The query that justifies the table: everything tagged with a topic.
    { name: 'repo_topics_topic_index', columns: ['topic'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 30 },
  },

  belongsTo: ['Repository'],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    topic: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(50) },
      factory: faker => faker.helpers.arrayElement(['typescript', 'bun', 'git', 'code-review', 'forge', 'self-hosted']),
    },
  },
} as const)
