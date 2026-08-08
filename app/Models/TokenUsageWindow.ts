import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * How much one token has created in the hour it is currently in.
 *
 * One row per token per action, rewritten in place as the window rolls. Not one
 * row per event: a token doing its job writes a few hundred rows an hour, and a
 * table that grows with usage needs a sweeper, an index nobody sized, and a
 * decision about retention - all to answer a question that only ever needs one
 * integer.
 *
 * ## Why a table rather than the cache
 *
 * A budget that resets when the process restarts is not a budget. The failure
 * this exists for is a loop with no backoff, and a loop with no backoff will
 * outlive a deploy: a cache-backed counter hands it a fresh allowance every
 * time somebody ships, which is exactly when nobody is watching the graphs.
 *
 * It costs one upsert per created object. That is the same order as the insert
 * it is guarding, on an operation that already writes a row, sends a
 * notification and fires an event.
 *
 * ## The window is fixed, not sliding
 *
 * A sliding window needs the individual timestamps this deliberately does not
 * keep. A fixed window is coarser - a client can spend two hours' allowance
 * across one boundary - and it is what makes `Retry-After` a fact rather than a
 * guess, which matters more: a client that trusts `Retry-After` and is refused
 * anyway learns to ignore it.
 */
export default defineModel({
  name: 'TokenUsageWindow',
  table: 'token_usage_windows',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The only lookup there is: this token, this action. Unique, because two
    // rows for one pair would each count half the usage and the limit would be
    // twice what it says.
    { name: 'token_usage_windows_token_action_unique', columns: ['access_token_id', 'action'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  /*
   * Cascade, unlike the audit log's `SET NULL`.
   *
   * A counter is not a record of anything: it is a number that is only
   * meaningful while the token it belongs to exists. Keeping it after the token
   * is gone would leave a row nothing can ever read or clear.
   */
  belongsTo: [{ model: 'AccessToken', foreignKey: 'access_token_id', onDelete: 'cascade' }],

  attributes: {
    access_token_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Which budget: `pull_requests`, `comments` or `reviews`.
     *
     * A string rather than an enum, for the reason the audit log's `action` is:
     * an enum needs a migration for every new kind, and the cost of that is
     * somebody deciding not to meter something.
     */
    action: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(40) },
      factory: () => 'comments',
    },

    /**
     * When the current window opened, as an ISO timestamp.
     *
     * A string rather than epoch milliseconds, because a `number` attribute
     * becomes an `integer` column and epoch milliseconds passed the 32-bit
     * ceiling in 1970 plus 24 days. Every insert failed on it, and the failure
     * was invisible: the caller treats a counter error as "allow", so the
     * limit read as working and metered nothing at all.
     *
     * Seconds would have fit until 2038, which is the same bug with a longer
     * fuse.
     */
    window_started_at: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(40) },
      factory: () => new Date().toISOString(),
    },

    /** How many have landed in it. */
    used: {
      order: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },
  },
} as const)
