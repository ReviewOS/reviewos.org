import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One authorization in flight.
 *
 * The OAuth flow spans two requests with a trip through somebody else's server
 * in between, so what the second request needs has to survive the gap: the PKCE
 * verifier, the DPoP key the tokens will be bound to, and - most importantly -
 * *which identity this flow was started for*, so the callback can check the
 * `sub` it gets back against the account somebody asked to sign in as.
 *
 * Held in the database rather than in a cookie because the DPoP private key
 * belongs to this server: a key in a cookie is a key the browser has, and a
 * token bound to it is no longer bound to anything the client cannot move.
 *
 * Rows are single-use and short-lived. The callback deletes the row it
 * consumes, so a replayed callback finds nothing - which is the difference
 * between an authorization code that can be used once and one that can be used
 * whenever somebody replays the URL out of a log.
 */
export default defineModel({
  name: 'AtprotoAuthRequest',
  table: 'atproto_auth_requests',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'atproto_auth_requests_state_index', columns: ['state'], unique: true },
    { name: 'atproto_auth_requests_expiry_index', columns: ['expires_at'] },
  ],

  traits: {
    useTimestamps: true,
  },

  attributes: {
    /** The opaque value that comes back on the redirect and finds this row. */
    state: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(120) },
      factory: () => 'state',
    },

    /** The identity this flow was started for. The callback checks `sub` on it. */
    did: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    },

    handle: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(253) },
      factory: () => null,
    },

    /** The authorization server, so the callback talks to the same one. */
    issuer: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'https://auth.example',
    },

    token_endpoint: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(500) },
      factory: () => 'https://auth.example/token',
    },

    /** PKCE. Never leaves this server; the challenge is what went out. */
    verifier: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'verifier',
    },

    /** The DPoP keypair, as JWKs, encrypted at rest with the instance key. */
    sealed_key: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().required().max(4000) },
      factory: () => 'sealed',
    },

    /** The most recent nonce the server issued, replayed on the next request. */
    nonce: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * Who was signed in when this started, when anybody was.
     *
     * Null means "signing in"; a user id means "linking an identity to this
     * account", and the callback must not confuse the two - the second is an
     * authenticated action and the first creates a session.
     */
    user_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    expires_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().required().max(40) },
      factory: () => null,
    },
  },
})
