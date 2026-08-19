import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * How many commits somebody has landed on a repository.
 *
 * **Measured and stored, not counted on read**, and that is the whole reason
 * this table exists. Answering "who wrote this" honestly means walking the
 * history, and a `git shortlog` over a repository with two hundred thousand
 * commits is seconds of CPU - on a page people load constantly. Every forge
 * that shows a contributors list precomputes it; this is that precomputation,
 * and `MeasureContributorsJob` is what fills it, on the same push hook and the
 * same queue as the language breakdown.
 *
 * Rows are replaced wholesale when a repository is re-measured, for the reason
 * `repository_languages` replaces its own: a history rewrite can *remove*
 * somebody, and merging would leave them in the list forever.
 *
 * ## Why the identity is an email, and `user_id` is optional
 *
 * Git's idea of an author is a name and an email, chosen by whoever ran the
 * commit, and it has no connection to an account here. Most contributors to a
 * mirrored repository have no account on this instance at all. So the row keeps
 * what git said - which is the truth about the commit - and carries `user_id`
 * only when an address matches a verified local account, which is what lets the
 * list link to a profile and show an avatar.
 *
 * Matching on the address is deliberately not clever. A person with three
 * addresses appears three times, exactly as they do on every other forge,
 * because the alternative is guessing that two strangers with the same display
 * name are one person - and that guess attributes somebody's commits to
 * somebody else.
 */
export default defineModel({
  name: 'RepositoryContributor',
  table: 'repository_contributors',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The read: this repository's contributors, most commits first.
    { name: 'repository_contributors_repo_index', columns: ['repository_id', 'commits'] },
    // One row per address per repository. The measure deletes and re-inserts,
    // and two runs overlapping would otherwise double every contributor.
    { name: 'repository_contributors_repo_email_index', columns: ['repository_id', 'email'], unique: true },
    // The query that runs the other way: everything somebody has contributed
    // to, for a profile.
    { name: 'repository_contributors_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  // Repository-scoped: the row means nothing without the repository. The *user*
  // relation deliberately does not cascade - deleting an account does not erase
  // that somebody wrote the code, which is why the name and address are on the
  // row rather than only a foreign key.
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** As git recorded it, which is what the commits actually say. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: faker => faker.person.fullName(),
    },

    /**
     * Lower-cased before it is stored, because git does not do it and
     * `Chris@Example.com` and `chris@example.com` are one person by every rule
     * an email server applies.
     */
    email: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: faker => faker.internet.email().toLowerCase(),
    },

    commits: {
      order: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.number().required().min(0) },
      factory: faker => faker.number.int({ min: 1, max: 400 }),
    },

    /**
     * The local account this address belongs to, when it belongs to one.
     *
     * Null for everybody without an account here, which on a mirror is almost
     * everybody. Present, the list links to a profile and shows an avatar
     * instead of an initial.
     */
    user_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
