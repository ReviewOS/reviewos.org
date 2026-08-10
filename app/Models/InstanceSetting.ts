import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A setting an administrator changes without a deploy.
 *
 * The line between this table and `config/` is not "which is easier to edit" -
 * it is **who decides, and how often**. A value that is part of how this
 * deployment is built (the database host, the queue driver, the credential
 * patterns this organization issues) belongs in `config/`, versioned, reviewed,
 * and identical on every replica. A value that is a policy the person running
 * the instance holds - whether strangers may sign up - belongs here, because
 * the alternative is that changing your mind about it means an SSH session, a
 * file edit, and a restart that drops every connection.
 *
 * ## Key and value, with the catalogue in code
 *
 * `app/Ops/settings.ts` holds the definition of every key: its type, its
 * default, and what it does. That is deliberate rather than a column per
 * setting. A column per setting means a migration to make anything
 * configurable, and a migration to make something configurable is how somebody
 * decides not to - the same argument the `action` column on `AuditEvent` is
 * written around.
 *
 * What it costs is that the value is text and has to be parsed. That cost is
 * paid once, in the catalogue, which is also the only place that knows a key
 * exists - so an unknown key read anywhere is a type error rather than an
 * `undefined` somebody handles with `?? true`.
 *
 * ## Rows are absent until set
 *
 * A setting nobody has touched has no row, and reading it gives the catalogue's
 * default. Seeding every default at install would freeze them: an upgrade that
 * changes a default would leave every existing instance on the old one, having
 * never chosen it.
 */
export default defineModel({
  name: 'InstanceSetting',
  table: 'instance_settings',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One row per key, enforced by the database rather than by whoever writes
    // the next update: two rows for `registration` would make the answer depend
    // on which came back first, and the looser of the two is the one somebody
    // discovers.
    { name: 'instance_settings_key_unique', columns: ['key'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    key: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(60) },
      factory: () => 'registration',
    },

    /**
     * The value, as text, parsed by the catalogue.
     *
     * Text rather than a JSON column: every value here is a scalar somebody
     * chose from a short list or typed into a box, and a JSON column would
     * invite the first person who wants a list to put one in - at which point
     * the table has stopped being settings and started being a document store
     * with no schema.
     */
    value: {
      order: 2,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => 'open',
    },

    /**
     * Who last changed it.
     *
     * Beside the audit row rather than instead of it. The log says who changed
     * what and when, and this says who it is *now* - which is the question
     * asked on the settings page, where nobody wants to run a search to find
     * out whether the value in front of them is somebody's decision or a
     * default.
     */
    updated_by_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
