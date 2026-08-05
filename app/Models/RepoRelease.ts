import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A tag, plus what somebody wanted to say about it.
 *
 * Named `RepoRelease` rather than `Release`, and the reason is worth knowing:
 * the framework ships its own `Release` model on a `releases` table, for the
 * dashboard's library releases. An `app/Models/Release.ts` would override it by
 * name, and the generated migration would have dropped that table's columns -
 * so the framework's own dashboard actions would go on reading `version` and
 * `status` from a table that no longer has them. The `Repo` prefix is what
 * `RepoCollaborator` and `RepoTopic` already use for repository-scoped rows.
 *
 * A release is not a thing in git. The tag is the thing in git, and this row is
 * the notes, the assets and the decision that a particular tag is worth
 * announcing - so a repository's tags and its releases are deliberately
 * different lists, and a tag with no release row is a normal tag rather than a
 * missing release.
 *
 * `tag_name` rather than a foreign key, because tags live on disk. The
 * alternative is a `tags` table that has to be kept in step with every push,
 * and the first time it drifts the interface starts showing releases for tags
 * that no longer exist.
 */
export default defineModel({
  name: 'RepoRelease',
  table: 'repo_releases',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One release per tag. Two rows for `v1.0.0` would be two answers to what a
    // version is, and whichever the database returned first would win.
    { name: 'repo_releases_repo_tag_index', columns: ['repository_id', 'tag_name'], unique: true },
    // The release list, which is always newest first.
    { name: 'repo_releases_repo_published_index', columns: ['repository_id', 'published_at'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: ['Repository', 'User'],
  hasMany: ['RepoReleaseAsset'],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** Whose release this is. Null once the account is gone; the release is not. */
    user_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    tag_name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `v${faker.number.int({ min: 0, max: 4 })}.${faker.number.int({ min: 0, max: 20 })}.0`,
    },

    /**
     * The commit the tag pointed at when the release was published.
     *
     * Recorded rather than resolved on read, because a tag can be moved. If it
     * is, this is what says which commit was actually released - and a release
     * whose notes describe a commit nobody can name again is worth less than
     * no release.
     */
    target_sha: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.string.hexadecimal({ length: 40, casing: 'lower', prefix: '' }),
    },

    /** The headline. Falls back to the tag when nobody wrote one. */
    name: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => faker.lorem.words(3),
    },

    body: {
      order: 6,
      fillable: true,
      // `text`, not the default varchar(255). Release notes are a changelog,
      // and 255 characters is about three bullet points - the sort of ceiling
      // that is discovered by somebody's release being truncated.
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.paragraphs(2),
    },

    /**
     * Written but not announced.
     *
     * A draft is invisible to anybody without write access, which is what makes
     * it useful: release notes get written while the release is being prepared,
     * and a half-written changelog on a public page is worse than no page.
     */
    is_draft: {
      order: 7,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Released, but not the one to download.
     *
     * Separate from `is_draft` because they answer different questions: a
     * prerelease is public and findable, it is simply not what "latest" means.
     */
    is_prerelease: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Null while it is a draft, which is what makes the list query trivial. */
    published_at: {
      order: 9,
      fillable: true,
      type: 'datetime',
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
