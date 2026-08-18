import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A signing key this instance owns.
 *
 * For the tokens a job asks for: a deploy that authenticates to a cloud with a
 * short-lived token signed here needs somebody on the other side to be able to
 * verify it, which means a public key at a stable URL and a private half that
 * never leaves this instance.
 *
 * **Rotation is why this is a table rather than a file.** A key you cannot
 * replace without an outage is one nobody replaces: the old key has to keep
 * verifying while tokens signed with it are still alive, so there is a `kid` on
 * every token and more than one row here during a rotation. Retiring a key
 * stops it signing; it keeps verifying until it is deleted.
 */
export default defineModel({
  name: 'InstanceKey',
  table: 'instance_keys',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'instance_keys_kid_index', columns: ['kid'], unique: true },
    // The signer's question: which key is current.
    { name: 'instance_keys_purpose_index', columns: ['purpose', 'retired_at'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /** What these keys are for. `oidc` today; a signature scheme later. */
    purpose: {
      order: 1,
      fillable: true,
      default: 'oidc',
      validation: { rule: schema.string().required().max(40) },
      factory: () => 'oidc',
    },

    /**
     * The key id, published in the JWKS and carried in every token's header.
     *
     * Random rather than derived from the key: a `kid` computed from the public
     * key is a fingerprint, and publishing a fingerprint of a key you are about
     * to rotate tells a reader when you rotated it.
     */
    kid: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => 'k1',
    },

    algorithm: {
      order: 3,
      fillable: true,
      default: 'RS256',
      validation: { rule: schema.string().max(20) },
      factory: () => 'RS256',
    },

    /** The public half, as JWK, exactly as it is published. */
    public_jwk: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(8000) },
      factory: () => '{}',
    },

    /**
     * The private half, encrypted with `APP_KEY`.
     *
     * The same treatment as a workflow secret, and for a stronger reason: this
     * one signs statements a cloud provider will act on. A database backup that
     * leaks it is somebody able to mint a token for any repository here.
     */
    sealed_private: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: () => '',
    },

    /**
     * When it stopped signing.
     *
     * Null is the current key. A retired key still verifies - tokens signed
     * with it may have minutes left - and is deleted only when nothing it
     * signed can still be alive.
     */
    retired_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
})
