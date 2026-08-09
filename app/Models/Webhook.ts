import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * An outbound webhook.
 *
 * The URL is attacker-controlled and the request leaves from inside the
 * network, so nothing here is delivered without the address checks in
 * `app/Actions/Webhook/ssrf.ts`.
 *
 * The secret is what lets a receiver believe a payload came from us. It is
 * never shown again after creation, so the column is write-once from the
 * interface's point of view.
 */
export default defineModel({
  name: 'Webhook',
  table: 'webhooks',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'webhooks_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    url: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(2048) },
      factory: faker => `https://${faker.internet.domainName()}/hooks/reviewos`,
    },

    secret: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => faker.string.alphanumeric(40),
    },

    /**
     * The events this webhook wants, comma separated, or `*` for everything.
     *
     * A comma-separated string rather than JSON, because that is what
     * `subscribes()` reads and what `ManageWebhookAction` writes. This column
     * declared a JSON array and defaulted to `["*"]`, which nothing could
     * parse: a webhook created with the column default subscribed to nothing
     * and was silent forever, and its owner's only clue would have been that
     * nothing ever arrived - indistinguishable from the endpoint being wrong.
     *
     * Only rows written through the endpoint worked, which is why it survived.
     */
    events: {
      order: 4,
      fillable: true,
      type: 'text',
      default: '*',
      validation: { rule: schema.string() },
      factory: () => 'pr:opened,pr:merged,issue:opened',
    },

    content_type: {
      order: 5,
      fillable: true,
      default: 'application/json',
      validation: { rule: schema.enum(['application/json', 'application/x-www-form-urlencoded']) },
      factory: () => 'application/json',
    },

    active: {
      order: 6,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    /** How many deliveries have failed in a row, for the deactivation rule. */
    consecutive_failures: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    last_success_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
