import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One uploaded file.
 *
 * The row exists so that reading an attachment can be authorized. The bytes on
 * disk are named by a random key and say nothing about who may see them, and an
 * attachment on a private repository's issue is exactly as private as the issue
 * - so the serving action has to be able to get from a key in a URL to a
 * repository, and this is that.
 *
 * It also records who uploaded what, which is the first thing anybody asks for
 * when a forge is used to host something it should not be.
 *
 * Not polymorphic, deliberately. An attachment belongs to a *repository*, not
 * to the comment that happens to mention it: the same upload gets quoted into
 * three other issues, and a row that claimed to belong to one of them would be
 * wrong about the other two the moment somebody copied the markdown.
 */
export default defineModel({
  name: 'Attachment',
  table: 'attachments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'attachments_key_index', columns: ['key'], unique: true },
    { name: 'attachments_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'Repository', foreignKey: 'repository_id' }, { model: 'User', foreignKey: 'uploader_id' }],

  attributes: {
    /**
     * The whole name of the file, in the URL and on disk.
     *
     * Random rather than derived, because a filename is attacker-controlled and
     * an attachment outlives the repository name it was uploaded under.
     */
    key: {
      order: 1,
      fillable: true,
      unique: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    repository_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    uploader_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The name it was uploaded under, already reduced to safe characters.
     *
     * Kept for the reader rather than for the filesystem: somebody downloading
     * four logs needs to be able to tell them apart.
     */
    filename: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => null,
    },

    /**
     * What the bytes are, decided by reading them rather than by believing the
     * upload. The claim is a hint; a `.png` full of HTML is stored as what it
     * really is.
     */
    content_type: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => null,
    },

    byte_size: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },
  },
} as const)
