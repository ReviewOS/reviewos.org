import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A permanent AT Protocol identifier, linked to a local account.
 *
 * The row phase 10's decision produces. It is deliberately thin: a DID, the
 * handle it claimed when it was linked, and which local user it belongs to.
 * Nothing about the person's repository, their posts or their follows is
 * stored, because none of that is federated here - this instance learned who
 * somebody is and stopped.
 *
 * `did` is unique across the instance rather than per user: an identifier is
 * one account, and letting two local users claim the same DID would make
 * "signed in as this identity" ambiguous at exactly the moment it matters.
 *
 * The handle is cached for display and is **not** the identity. It changes when
 * somebody moves domain, and a stale one here is a label that needs refreshing
 * rather than a permission that needs revoking - which is the property that
 * makes handles safe to show and unsafe to authorise against.
 */
export default defineModel({
  name: 'AtprotoIdentity',
  table: 'atproto_identities',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'atproto_identities_did_index', columns: ['did'], unique: true },
    { name: 'atproto_identities_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useUuid: true,
  },

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    did: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    },

    /** What it called itself when it was linked. Refreshed, never trusted. */
    handle: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(253) },
      factory: () => null,
    },

    /** Where the account's repository lived, for a person reading the row. */
    pds: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    last_verified_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
})
