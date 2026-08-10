import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * The link between an account here and an account at an identity provider.
 *
 * ## Keyed on `sub`, never on email
 *
 * The single most important decision in this table. `sub` is the provider's
 * stable identifier for a person and is guaranteed not to change; an email
 * address changes when somebody marries, or when a company renames its domain,
 * or when an address is recycled to a *different person* after they leave.
 *
 * Matching on email gets all three wrong in the same direction: the first two
 * silently create a second account and strand the first one's review history,
 * and the third hands the new joiner the leaver's account. Every one of those
 * is a story somebody has lived through, and the fix is a column.
 *
 * The issuer is part of the key too, because `sub` is only unique within a
 * provider. An instance federating with two identity providers - a company one
 * and a contractor one - would otherwise let a collision between them merge two
 * people into one account.
 *
 * ## What it makes possible
 *
 * Deprovisioning. "Removing somebody upstream ends their sessions" needs
 * something that says which local account an upstream removal refers to, and
 * this is it. Without the link, the answer is a guess by email, which is the
 * mistake above with worse consequences.
 */
export default defineModel({
  name: 'SsoIdentity',
  table: 'sso_identities',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The lookup on every single sign-on: this issuer, this subject.
    { name: 'sso_identities_subject_index', columns: ['issuer', 'subject'], unique: true },
    { name: 'sso_identities_user_index', columns: ['user_id'] },
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

    /** The provider's own identifier for itself, from the `iss` claim. */
    issuer: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => null,
    },

    /** The provider's stable identifier for this person, from `sub`. */
    subject: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => null,
    },

    /**
     * The email the provider last asserted, for display only.
     *
     * Recorded rather than trusted: it is useful when an administrator is
     * working out which upstream account a local one corresponds to, and it is
     * never what the lookup matches on. Storing it and not keying on it is the
     * whole discipline of this table in one column.
     */
    email: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /**
     * The groups the provider last asserted, as JSON.
     *
     * A snapshot rather than the authority. Team membership is written into
     * `team_members` at sign-in, because that is what the permission checks
     * read; this column exists so an administrator can see what the provider
     * actually said when the mapping did something surprising - which, with
     * group names, it will.
     */
    groups: {
      order: 5,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '[]',
    },

    last_seen_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
