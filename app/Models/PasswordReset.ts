import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A pending password reset: the token, and when it stops working.
 *
 * ## Why this file exists at all
 *
 * The framework creates `password_resets` itself, as part of the auth tables,
 * and its version has no `expires_at` - while the framework's *own*
 * `sendEmail` writes one. So the insert failed, the action swallowed the
 * failure on purpose (an unknown address and a dead transport must not be
 * tellable apart, or the endpoint becomes an account oracle), and every reset
 * link this forge ever sent was invalid. The reader got a cheerful "if that
 * address has an account, a link is on its way" and nothing had been written.
 *
 * That was patched with the one hand-written migration in this repository,
 * `0000000077-alter-password_resets-columns.sql`, which added the column with
 * an `ALTER`. It worked and it was the wrong shape: this project generates
 * migrations from models and reviews them, precisely so that the schema has
 * one description rather than a model plus a pile of corrections. A
 * hand-written `ALTER` against a table no model describes is invisible to
 * `buddy generate:migrations`, so the next regeneration would drop it and the
 * bug would come back silently.
 *
 * Declaring the model here is what makes the column part of the schema rather
 * than a correction to it. `app/Models/` wins over the framework's defaults,
 * so this *is* the description of the table from now on.
 *
 * **The framework is still wrong** and should be fixed there too: a table
 * whose writer expects a column the schema does not have is a bug for every
 * Stacks application, not just this one. This is the local half.
 *
 * ## Not `useTimestamps`
 *
 * `created_at` only. There is no `updated_at`, and there should not be: a reset
 * token is written once and consumed or expired. A row that could be updated
 * would invite extending an expiry in place, which is the one edit that turns
 * a short-lived credential into a long-lived one.
 */
export default defineModel({
  name: 'PasswordReset',
  table: 'password_resets',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The only query the flow makes: this address, this token.
    { name: 'password_resets_email_index', columns: ['email'] },
  ],

  traits: {
    useTimestamps: false,
  },

  attributes: {
    /**
     * The address the link was sent to, not a user id.
     *
     * Deliberately, and it matches what the framework writes: a reset is
     * requested by typing an address, and resolving it to an account at
     * request time would mean answering differently for an address that has
     * one - which is the oracle this whole flow is shaped to avoid.
     */
    email: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => faker.internet.email(),
    },

    /**
     * The token, as stored.
     *
     * Compared rather than displayed; the value that reaches the reader lives
     * only in the email. Sized to the framework's column so the two agree.
     */
    token: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => crypto.randomUUID(),
    },

    /**
     * When the link stops working.
     *
     * The column the framework writes and did not have. Nullable, matching
     * what is already on disk in every existing install: a row written before
     * this was fixed has no expiry recorded, and making the column required
     * would fail the migration on exactly those rows. The reset flow treats a
     * missing expiry as expired, which is the safe reading.
     */
    expires_at: {
      order: 3,
      fillable: true,
      validation: { rule: schema.timestamp() },
      factory: () => new Date(Date.now() + 3_600_000).toISOString(),
    },

    created_at: {
      order: 4,
      fillable: true,
      validation: { rule: schema.timestamp() },
      factory: () => new Date().toISOString(),
    },
  },
})
