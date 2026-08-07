import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A record of one thing actually sent, overriding the framework default.
 *
 * The default at `storage/framework/defaults/app/Models/NotificationDelivery.ts`
 * declares `userId` as a plain numeric attribute with no `belongsTo` at all, so
 * nothing generated a constraint and nothing stopped a row pointing at an
 * account that had been deleted. That is the same defect
 * `tests/unit/migrations-from-models.test.ts` was written about, and its comment
 * names two other columns it had already caught: a relation written as an
 * attribute is a relation the database never learns about.
 *
 * `onDelete: 'set null'` rather than the cascade its sibling uses, deliberately.
 * `notifications` is an inbox and an entry for a deleted account is unreachable.
 * This is a log of what was *sent*, and it carries `recipient` - the address it
 * went to - independently of any account. Deleting a user should unlink the
 * record, not erase the evidence that mail went out.
 */
export default defineModel({
  name: 'NotificationDelivery',
  table: 'notification_deliveries',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'channel', 'recipient', 'subject', 'status', 'sentAt'],
      searchable: ['recipient', 'subject', 'body', 'error'],
      sortable: ['channel', 'recipient', 'status', 'sentAt', 'createdAt'],
      filterable: ['channel', 'status'],
    },
    useApi: {
      uri: 'notification-deliveries',
      routes: ['index', 'show', 'destroy'],
    },
  },

  belongsTo: [{ model: 'User', onDelete: 'set null' }],

  attributes: {
    channel: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.enum(['email', 'sms', 'chat', 'database', 'push', 'broadcast']),
      },
    },

    recipient: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(1000),
      },
    },

    subject: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },

    body: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(10000),
      },
    },

    /**
     * `skipped` is added to the framework's four.
     *
     * "The recipient turned this channel off" and "this repository is muted"
     * are neither failures nor pending: recording them as `failed` would put
     * a deliberate choice in the same column as a refused mail server, and
     * recording them as `pending` would claim something is still going to
     * happen. Somebody asking why they did not hear about a merge deserves the
     * actual answer, and this is the row that has it.
     */
    status: {
      required: true,
      fillable: true,
      default: 'pending',
      validation: {
        rule: schema.enum(['pending', 'sent', 'delivered', 'failed', 'skipped']),
      },
    },

    error: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.string().max(5000),
      },
    },

    metadata: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
    },

    sentAt: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.timestamp(),
      },
    },
  },
} as const)
