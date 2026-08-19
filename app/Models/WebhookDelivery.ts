import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One attempt to deliver one event.
 *
 * Kept per attempt rather than per event so a delivery log can show what was
 * actually sent and what came back, which is the only way somebody debugging
 * their endpoint can tell our fault from theirs. It is also what redelivery
 * replays.
 */
export default defineModel({
  name: 'WebhookDelivery',
  table: 'webhook_deliveries',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'webhook_deliveries_repository_index', columns: ['repository_id'] },
    { name: 'webhook_deliveries_webhook_index', columns: ['webhook_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 30 },
  },

  belongsTo: ['Webhook'],

  attributes: {
    webhook_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    event: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => faker.helpers.arrayElement(['pr:opened', 'pr:merged', 'issue:opened', 'ping']),
    },

    /** The exact bytes signed and sent. Re-serialising would change the digest. */
    payload: {
      order: 3,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '{"event":"ping"}',
    },

    request_headers: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '{"content-type":"application/json"}',
    },

    response_status: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: faker => faker.helpers.arrayElement([200, 204, 500, 404]),
    },

    response_body: {
      order: 6,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => 'ok',
    },

    duration_ms: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 20, max: 3000 }),
    },

    attempt: {
      order: 8,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1, max: 3 }),
    },

    /** Set when the request never reached a server at all. */
    error: {
      order: 9,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    delivered_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },

    /**
     * The repository this belongs to, copied from its webhook.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its webhook crosses keyspaces - the one
     * thing sharding by repository was chosen to avoid.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
