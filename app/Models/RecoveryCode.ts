import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One of the codes that gets somebody back in when the phone is gone.
 *
 * The part of two-factor that decides whether people turn it on. Everybody
 * understands the second factor; what stops them is the thought of losing the
 * device, and a recovery code is the answer to that - so it has to be issued
 * with the same click that enables the factor, shown once, and stored in a way
 * that survives the account owner's laptop being reinstalled.
 *
 * ## Hashed, like a password, because that is what it is
 *
 * A recovery code bypasses the second factor completely. A database dump
 * containing them is a database dump containing a way past two-factor for every
 * account on the instance - which is exactly what two-factor was bought to
 * prevent. So the column holds a hash and the plaintext exists once, in the
 * response that created it.
 *
 * ## A row per code, not a list on the user
 *
 * Because they are used one at a time and each use has to be recorded. A JSON
 * array on `users` would be read, edited and written back, and two recoveries
 * racing would restore a code the other had just spent - which is the one bug
 * in this feature that hands somebody an infinite second factor.
 */
export default defineModel({
  name: 'RecoveryCode',
  table: 'recovery_codes',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The only query: this person's unused codes.
    { name: 'recovery_codes_user_index', columns: ['user_id', 'used_at'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'User', onDelete: 'cascade' }],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** SHA-256 of the code as it was shown. Never the code. */
    code_hash: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    /**
     * When it was spent.
     *
     * Kept rather than deleted, so "I used one of these last March" is a
     * question the row can answer. A used code is dead either way; a deleted
     * one takes its own history with it, and this is a security feature where
     * the history is half the value.
     */
    used_at: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
