import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A secret a job may read, encrypted with this instance's key.
 *
 * **There is no way to read one back.** A listing gives names; the only
 * consumer is a job on a machine an operator provided. A reveal button is the
 * feature that turns one compromised session into every credential an
 * organization has, and not having it is worth more than saving somebody a trip
 * to their password manager.
 *
 * The `sealed` column is ciphertext from `@stacksjs/security`, keyed on
 * `APP_KEY`. A value this instance can no longer decrypt - because the key
 * changed - is skipped rather than delivered empty: a job handed an empty
 * credential authenticates as nobody and fails somewhere far from the cause.
 */
export default defineModel({
  name: 'WorkflowSecret',
  table: 'workflow_secrets',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_secrets_scope_index', columns: ['scope_type', 'scope_id', 'key'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    /**
     * `instance`, `pool`, `owner`, `repository`, or `environment`.
     *
     * `environment` is the one that earns the feature: a deploy credential
     * attached to `production` is not reachable from the test job in the same
     * run, which is exactly the separation a repository-wide secret cannot
     * express.
     *
     * `pool` is the one that belongs to the machines rather than to the code. A
     * registry credential that exists because *these* runners are allowed to
     * publish is not a fact about any repository, and writing it into each
     * repository that needs it is how a credential ends up in twenty places and
     * is rotated in three.
     */
    scope_type: {
      order: 1,
      fillable: true,
      default: 'repository',
      validation: { rule: schema.enum(['instance', 'pool', 'owner', 'repository', 'environment']) },
      factory: () => 'repository',
    },

    /** The pool, owner, repository, or environment. Zero for the instance. */
    scope_id: {
      order: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    key: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'DEPLOY_TOKEN',
    },

    /** The ciphertext. Never logged, never returned, never rendered. */
    sealed: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(20_000) },
      factory: () => '',
    },

    /**
     * Who set it last.
     *
     * The only auditable fact about a secret that can be kept without keeping
     * the secret, and the first question after an incident is who last touched
     * the credential.
     */
    updated_by_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
