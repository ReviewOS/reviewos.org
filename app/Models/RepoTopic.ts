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

  // Repository-scoped: this row means nothing without the repository, so the
  // database removes it rather than the application remembering to. An
  // application that deletes a parent and then its children has to get the
  // order right in every place it deletes, forever, and the place it misses
  // leaves rows nothing can reach - while the database applies the rule to
  // deletes the application never made: a manual DELETE, a restore, another
  // service sharing the schema.
  //
  // Only the repository relation cascades. Deleting a *user* deliberately does
  // not take their issues, comments or reviews with them: that is a history
  // other people took part in, and it is the reason those rows carry an
  // external author name.
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

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
