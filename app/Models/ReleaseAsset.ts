import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A file attached to a release: a built binary, a checksum file, a signature.
 *
 * Deliberately not the source archive. That one is generated on demand by
 * `git archive` from the tag, so it cannot drift from the tag it claims to be
 * and costs no storage. An asset here is something that could not be produced
 * from the repository - a compiled artefact, a signature over it.
 *
 * `download_count` is the one thing about a release people ask for and cannot
 * get anywhere else: it is the only signal that anybody is using a version.
 */
export default defineModel({
  name: 'ReleaseAsset',
  table: 'release_assets',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One name per release. A second `checkout-linux-amd64` in one release is
    // two answers to which file that name means.
    { name: 'release_assets_release_name_index', columns: ['release_id', 'name'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 15 },
  },

  belongsTo: ['Release'],

  attributes: {
    release_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** What it is called when it lands in somebody's downloads folder. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `${faker.lorem.word()}-linux-amd64.tar.gz`,
    },

    /** Where the bytes are, in whatever the storage driver is. */
    storage_path: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(500) },
      factory: faker => `releases/${faker.string.uuid()}`,
    },

    /**
     * The type the file is *served* as, which is not the type it claims to be.
     *
     * A release asset is a stranger's file, so it is served as a download and
     * never as its own type - the same rule the raw file endpoint follows, and
     * for the same reason. This column records what was declared, for display.
     */
    content_type: {
      order: 4,
      fillable: true,
      default: 'application/octet-stream',
      validation: { rule: schema.string().max(160) },
      factory: () => 'application/octet-stream',
    },

    size_bytes: {
      order: 5,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1024, max: 80_000_000 }),
    },

    /**
     * SHA-256 of the bytes, hex.
     *
     * Recorded on upload so a download can be checked without trusting the
     * transport, and so an asset that was replaced can be told from one that
     * was not.
     */
    checksum: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: faker => faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    },

    download_count: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 5000 }),
    },
  },
} as const)
