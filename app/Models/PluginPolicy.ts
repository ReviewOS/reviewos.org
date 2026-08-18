import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Which plugins may run, at one of three levels.
 *
 * A plugin runs *around* a job rather than as a step: before the checkout,
 * after the artifacts, with the machine's environment. So a plugin reference in
 * a workflow file is arbitrary code selection by whoever can edit that file,
 * and an instance that lets any repository name any plugin has handed the
 * fleet to whoever can open a pull request.
 *
 * **One table for all three levels**, rather than columns on the instance
 * settings, the organization, and the pool. The rules are the same rules
 * wherever they are set - an allowlist, a pinning requirement, a set of
 * capabilities - and three copies of them would drift the first time one grew
 * a field.
 *
 * Each level only ever narrows what the level above allowed. That is enforced
 * in `app/Actions/Plugin/policy.ts` rather than here, because it is a property
 * of the combination and not of any one row.
 */
export default defineModel({
  name: 'PluginPolicy',
  table: 'plugin_policies',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'plugin_policies_scope_index', columns: ['scope_type', 'scope_id'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /**
     * Which level this row is.
     *
     * `instance` has no id, which is why the column is nullable and why the
     * unique index covers both: one instance policy, one per owner, one per
     * pool, and a second row for the same subject is a configuration nobody
     * could reason about.
     *
     * A user and an organization are separate scopes rather than one `owner`,
     * because the two namespaces share an id space - `owner 3` would be two
     * different subjects depending on which table you looked in.
     */
    scope_type: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.enum(['instance', 'user', 'organization', 'pool']) },
      factory: () => 'instance',
    },

    scope_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The plugins permitted here, one reference per line.
     *
     * Empty means every plugin, which is what every existing install has: an
     * allowlist that meant *nothing* when empty would turn plugins off for
     * everybody who never opened this screen.
     *
     * Newline-separated rather than a relation, because the entries are not
     * rows anybody joins on - they are a list an operator edits as a block, and
     * a table of them would be six queries to read one policy.
     */
    allowlist: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(10_000) },
      factory: () => '',
    },

    /**
     * Whether a plugin has to be pinned to a commit or a tag.
     *
     * A branch reference is a plugin whose contents change under a repository
     * that already passed review, which is the supply chain problem in one
     * line.
     */
    require_pinned: {
      order: 4,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Capabilities granted here: `docker-socket`, `host-network`, `privileged`,
     * `host-mounts`.
     *
     * Empty means none, which is deliberately the other way round from the
     * allowlist. A pool with no configuration should not be handing out a
     * docker socket, and a plugin that needs one should have to be let in.
     */
    capabilities: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => '',
    },
  },
})
