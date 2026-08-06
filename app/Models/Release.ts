import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A release: a tag, plus what somebody wanted to say about it.
 *
 * **Published from the framework default** (`buddy publish:model Release`) and
 * extended, rather than written fresh. That distinction is the whole reason
 * this file reads the way it does. A userland model *replaces* a framework
 * default instead of merging with it, and the migration generator treats the
 * surviving model as the truth - so a hand-written `Release` here would have
 * emitted `ALTER TABLE releases DROP COLUMN version` while the framework's own
 * dashboard actions went on selecting it. Applied cleanly, said nothing, and
 * would have failed a page that had always worked. The framework now refuses to
 * generate that migration and points at `publish:model`; this file is what
 * publishing then extending looks like.
 *
 * So every column the framework declared is still here, and the forge's
 * columns sit alongside them - and where the two mean the same thing, the
 * framework's column is *used* rather than duplicated:
 *
 *   version   the tag, which is what a release's version is
 *   status    `draft` or `published`, so there is no second is_draft flag
 *   notes     the release body
 *   downloads the total across this release's assets
 *   author    who published it, in words, next to `user_id`
 *
 * `type` is the one that has no forge meaning - a git tag is not a decision
 * about major, minor or patch - so it is no longer required. Relaxing a
 * constraint keeps the column and every row in it; the dashboard still writes
 * it, and a release published from a repository leaves it empty.
 *
 * A release is not a thing in git. The tag is the thing in git, and this row is
 * the notes, the assets and the decision that a particular tag is worth
 * announcing - so a repository's tags and its releases are deliberately
 * different lists, and a tag with no release row is a normal tag.
 */
export default defineModel({
  name: 'Release',
  table: 'releases',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One release per tag, per repository. Two rows for `v1.0.0` would be two
    // answers to what a version is, and whichever the database returned first
    // would win. Not unique across the table: the framework's own library
    // releases have no repository, so they would all collide on NULL.
    { name: 'releases_repo_tag_index', columns: ['repository_id', 'tag_name'], unique: true },
    // The release list, which is always newest first.
    { name: 'releases_repo_published_index', columns: ['repository_id', 'published_at'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'version', 'type', 'status', 'createdAt'],
      searchable: ['version', 'type', 'notes'],
      sortable: ['createdAt', 'version'],
      filterable: ['type', 'status'],
    },

    useApi: {
      uri: 'releases',
      routes: ['index', 'show'],
    },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }, 'User'],
  hasMany: ['ReleaseAsset'],

  attributes: {
    version: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().required().max(50),
      },
      factory: faker => faker.system.semver(),
    },

    type: {
      order: 2,
      fillable: true,
      // No longer required. A git tag is not a decision about major, minor or
      // patch, and a release published from a repository has nothing sensible
      // to put here. The dashboard still writes it; the column and its rows are
      // untouched.
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.helpers.arrayElement(['major', 'minor', 'patch']),
    },

    status: {
      order: 3,
      fillable: true,
      // `draft` or `published` for a repository release, and the framework's
      // `scheduled` alongside them. One column rather than a second `is_draft`
      // flag that could disagree with it.
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.helpers.arrayElement(['published', 'draft', 'scheduled']),
    },

    notes: {
      order: 4,
      fillable: true,
      // `text`, not the default varchar(255). Release notes are a changelog,
      // and 255 characters is about three bullet points - the sort of ceiling
      // discovered by somebody's release being truncated.
      type: 'text',
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.lorem.paragraph(),
    },

    downloads: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 0, max: 50000 }),
    },

    author: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.person.fullName(),
    },

    /** Null for the framework's own library releases, which have no repository. */
    repository_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Who published it. Null once the account is gone; the release is not. */
    user_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The git tag this release announces. */
    tag_name: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => `v${faker.number.int({ min: 0, max: 4 })}.${faker.number.int({ min: 0, max: 20 })}.0`,
    },

    /**
     * The commit the tag pointed at when the release was published.
     *
     * Recorded rather than resolved on read, because a tag can be moved. If it
     * is, this is what says which commit was actually released - and a release
     * whose notes describe a commit nobody can name again is worth less than no
     * release.
     */
    target_sha: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.string.hexadecimal({ length: 40, casing: 'lower', prefix: '' }),
    },

    /** The headline. Falls back to the tag when nobody wrote one. */
    name: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => faker.lorem.words(3),
    },

    /**
     * Released, but not the one to download.
     *
     * Separate from `status` because they answer different questions: a
     * prerelease is published and findable, it is simply not what "latest"
     * means.
     */
    is_prerelease: {
      order: 12,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Null while it is a draft, which is what makes the list query trivial. */
    published_at: {
      order: 13,
      fillable: true,
      type: 'datetime',
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
