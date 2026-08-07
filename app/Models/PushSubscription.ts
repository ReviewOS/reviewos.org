import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One browser that agreed to be interrupted.
 *
 * **One row per browser, not per person.** Somebody with a laptop and a desktop
 * has two, and revoking the one at the office should not sign them out at home.
 * That is not a nicety: the alternative is people never revoking anything,
 * because doing so costs them the desk they are actually at.
 *
 * The three fields the protocol needs are the browser's, not ours. `endpoint`
 * is a URL at Google's or Mozilla's push service that identifies this
 * subscription; `p256dh` is the browser's public key and `auth` a secret it
 * generated. All three arrive together from `PushSubscription.toJSON()` and are
 * useless apart, which is why they are one row rather than three columns
 * somebody could half-populate.
 *
 * **None of them is a credential for this product.** They are a capability to
 * ring one browser, and anybody holding all three can send it a notification -
 * so they are stored as given, never rendered, and never leave the server.
 *
 * `last_seen_at` is what makes pruning possible without guessing: a browser
 * that has not confirmed its subscription in months is one whose owner
 * reinstalled, and the endpoint will answer 410 the next time anybody tries.
 */
export default defineModel({
  name: 'PushSubscription',
  table: 'push_subscriptions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: [{ model: 'User', onDelete: 'cascade' }],

  attributes: {
    /**
     * The push service URL for this browser.
     *
     * `text`, not a varchar. These are long - FCM's run past 200 characters
     * before the token - and Postgres refuses an over-length varchar rather
     * than truncating, so a limit here is a subscription silently lost at
     * insert on exactly the browsers that are most common.
     */
    endpoint: {
      required: true,
      fillable: true,
      unique: true,
      type: 'text',
      validation: {
        rule: schema.string(),
      },
    },

    /**
     * The browser's public key, base64url. 65 bytes as an uncompressed point.
     *
     * The Push API calls this `p256dh`, which names the curve rather than the
     * thing. That is a wire name and it stays on the wire: it is mapped where
     * the browser's JSON is read, and the column says what it holds.
     */
    publicKey: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },

    /**
     * The shared secret the browser generated, base64url.
     *
     * `auth` on the wire, which in this codebase would read as authentication.
     * It is neither a credential for this product nor a password; it is an
     * input to the key derivation that hides the payload from the push service.
     */
    authSecret: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },

    /**
     * What the browser said it was, when it subscribed.
     *
     * Shown in settings so somebody can tell which row is the laptop they
     * left at the office. Without it the list is three identical entries and
     * revoking becomes a guess.
     */
    userAgent: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.string().max(500),
      },
    },

    lastSeenAt: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.timestamp(),
      },
    },
  },
} as const)
