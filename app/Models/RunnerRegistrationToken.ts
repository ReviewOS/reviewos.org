import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A credential a machine registers itself with, scoped to one pool.
 *
 * The credential an autoscaler's cloud-init should carry, and the reason this
 * exists: today a scaler needs an *administrator's* token to call
 * `create-runner`, which means the widest credential on the instance is sitting
 * in a userdata blob on every machine it starts. A registration token can do
 * exactly one thing - add a machine to one pool - and that is the whole of the
 * blast radius when a machine is compromised or a userdata blob leaks.
 *
 * **It is not the runner's credential.** Registering mints a per-runner
 * credential and the machine uses that from then on, which is the same shape as
 * the job token: a long-lived credential is exchanged for a narrow one at the
 * first opportunity. By [the threat model](../../docs/ci-threat-model.md) a
 * registration credential must never reach a job environment, and the only way
 * to keep that promise is for the thing running jobs to be holding something
 * else.
 *
 * First use and last use are recorded because they answer the two questions
 * asked about a credential nobody remembers making: has this ever been used,
 * and is it still being used. A token with a first-use of null is one to delete
 * without asking anybody.
 */
export default defineModel({
  name: 'RunnerRegistrationToken',
  table: 'runner_registration_tokens',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The lookup on every registration.
    { name: 'runner_registration_tokens_hash_index', columns: ['token_hash'], unique: true },
    { name: 'runner_registration_tokens_pool_index', columns: ['runner_pool_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'RunnerPool', onDelete: 'cascade' }],

  attributes: {
    runner_pool_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** What it is for, in the operator's words: `us-east autoscaler`. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'registration',
    },

    /**
     * SHA-256 of the credential.
     *
     * Shown once at creation and never again, like every other credential
     * here: one in the database in plain text is one in every backup.
     */
    token_hash: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    /**
     * The queue machines registering with it join.
     *
     * Optional: a token for a pool with one queue does not need to say which,
     * and a scaler that manages several passes the queue at registration.
     */
    runner_queue_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    first_used_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    last_used_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /** How many machines have registered with it, for a screen that ranks them. */
    uses: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * When it stops working.
     *
     * Revoked rather than deleted, because the audit trail of "which token did
     * that machine register with" outlives the token - and a row that is gone
     * answers that question with silence.
     */
    revoked_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /** An expiry, for a token that should not outlive the afternoon. */
    expires_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    created_by_id: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
